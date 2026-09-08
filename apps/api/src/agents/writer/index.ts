/**
 * Writer Agent public surface (W0-W2).
 *
 * runWriterOnce is the only supported way to start a writer run in this
 * phase. It validates run identifiers and the writer brief at the boundary
 * (invalid input is rejected before the graph is touched), builds a fresh
 * compiled graph with the injected read-only context adapters and AI planner
 * and returns the resting state of the run: the bounded, source-labelled
 * context gatherContext produced and, when planning succeeded, the proposed
 * structural article plan resting on awaiting_approval.
 *
 * A run is identified by a writer run id (wr_<uuid>) that is unique per run
 * and doubles as the correlation handle callers store next to a run; when
 * checkpointing lands it becomes the LangGraph thread id for that run. The
 * requestId is the caller-supplied correlation id and travels inside the
 * state so it survives every checkpoint.
 */

import { randomUUID } from 'node:crypto';
import { ApiError } from '../../apiErrors.js';
import { emptyWriterContext, type WriterContext, type WriterContextDependencies } from './context.js';
import { createWriterGraph } from './graph.js';
import type { WriterPlannerDependencies } from './planner.js';
import type { WriterPlan, WriterPlanStatus, WriterState, WriterStatus } from './state.js';

export { createWriterGraph, WRITER_INITIALIZE_NODE, WRITER_GATHER_NODE, WRITER_PLAN_NODE } from './graph.js';
export * from './context.js';
export * from './planner.js';
export {
  STATUS_TRANSITIONS,
  WRITER_STATUSES,
  WriterStateAnnotation,
  assertStatusTransition,
  type WriterPlan,
  type WriterPlanStatus,
  type WriterRelatedContent,
  type WriterSection,
  type WriterState,
  type WriterStateUpdate,
  type WriterStatus,
} from './state.js';

export const WRITER_RUN_ID_PREFIX = 'wr_';
/** Unique correlation id for a writer run; future LangGraph thread id. */
export type WriterRunId = `${typeof WRITER_RUN_ID_PREFIX}${string}`;

/** Longest accepted topic for a writer run. */
export const WRITER_MAX_TOPIC_CHARS = 500;
/** Longest accepted target keyword for a writer run. */
export const WRITER_MAX_TARGET_KEYWORD_CHARS = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Upper bound on caller-supplied request ids (kept tiny on purpose). */
const MAX_REQUEST_ID_LENGTH = 200;

/** Creates a fresh, unique writer run id. */
export function createWriterRunId(): WriterRunId {
  return `${WRITER_RUN_ID_PREFIX}${randomUUID()}`;
}

/** True when the value is a well-formed writer run id. */
export function isWriterRunId(value: unknown): value is WriterRunId {
  return typeof value === 'string' && value.startsWith(WRITER_RUN_ID_PREFIX) && UUID_RE.test(value.slice(WRITER_RUN_ID_PREFIX.length));
}

/** Caller-supplied identifiers and brief for starting a writer run. */
export interface WriterRunRequest {
  /** Optional explicit run id; generated when omitted. */
  runId?: WriterRunId;
  /** Project scope the run belongs to (uuid). */
  projectId: string;
  /** Caller correlation id, carried inside the run state. */
  requestId: string;
  /** The subject the run gathers context for (required, non-whitespace). */
  topic: string;
  /** Optional primary keyword to focus retrieval on. */
  targetKeyword?: string;
}

/** Injectable seams for a writer run: the read-only context adapters and the
 *  AI planner. Each is optional; without one the matching capability reports
 *  itself not wired and the run degrades honestly. */
export interface WriterRunDependencies {
  context?: WriterContextDependencies;
  planner?: WriterPlannerDependencies;
}

/** Outcome of a writer run: the run id plus the resting state (identity,
 *  brief, the bounded context gatherContext produced and the planning
 *  outcome). A proposed plan rests on awaiting_approval; a run that could not
 *  plan rests on failed with planStatus "failed" and no fabricated plan. */
export interface WriterRunResult {
  runId: WriterRunId;
  projectId: string;
  requestId: string;
  topic: string;
  targetKeyword: string | null;
  status: WriterStatus;
  context: WriterContext;
  plan: WriterPlan | null;
  planStatus: WriterPlanStatus;
  planNote: string | null;
}

/**
 * Coerces and validates run input before any graph work happens. Identity
 * fields must be present and well-formed, topic must be a real string and
 * every field is length-capped; a malformed run is rejected as a 400
 * bad_request instead of half-starting a graph run.
 */
export function parseWriterRunRequest(input: WriterRunRequest): WriterState {
  const { runId, projectId, requestId, topic, targetKeyword } = input;
  if (typeof projectId !== 'string' || !UUID_RE.test(projectId.trim())) {
    throw ApiError.badRequest('A valid projectId (uuid) is required', { projectId });
  }
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw ApiError.badRequest('A non-empty requestId is required');
  }
  if (requestId.trim().length > MAX_REQUEST_ID_LENGTH) {
    throw ApiError.badRequest(`requestId must be at most ${MAX_REQUEST_ID_LENGTH} characters`);
  }
  const trimmedTopic = typeof topic === 'string' ? topic.trim() : '';
  if (!trimmedTopic) {
    throw ApiError.badRequest('A non-empty topic is required');
  }
  if (trimmedTopic.length > WRITER_MAX_TOPIC_CHARS) {
    throw ApiError.badRequest(`topic must be at most ${WRITER_MAX_TOPIC_CHARS} characters`);
  }
  let normalizedKeyword: string | null = null;
  if (targetKeyword !== undefined) {
    if (typeof targetKeyword !== 'string') {
      throw ApiError.badRequest('targetKeyword, when provided, must be a string');
    }
    const trimmedKeyword = targetKeyword.trim();
    if (trimmedKeyword.length > WRITER_MAX_TARGET_KEYWORD_CHARS) {
      throw ApiError.badRequest(`targetKeyword must be at most ${WRITER_MAX_TARGET_KEYWORD_CHARS} characters`);
    }
    normalizedKeyword = trimmedKeyword || null;
  }
  if (runId !== undefined && !isWriterRunId(runId)) {
    throw ApiError.badRequest('runId, when provided, must be a writer run id (wr_<uuid>)', { runId });
  }
  return {
    projectId: projectId.trim(),
    requestId: requestId.trim(),
    topic: trimmedTopic,
    targetKeyword: normalizedKeyword,
    status: 'idle',
    context: emptyWriterContext(),
    planStatus: 'none',
    plan: null,
    planNote: null,
  };
}

/**
 * Runs the writer graph once for a validated request and returns the resting
 * state. Context adapters and the AI planner are optional: without them every
 * source reports not configured and planning reports "no AI planner wired",
 * ending the run failed instead of fabricating a plan. Throws
 * ApiError.badRequest for malformed input; genuine run failures surface from
 * the graph.
 */
export async function runWriterOnce(
  input: WriterRunRequest,
  deps: WriterRunDependencies = {},
): Promise<WriterRunResult> {
  const start = parseWriterRunRequest(input);
  const runId = input.runId ?? createWriterRunId();
  const graph = createWriterGraph(deps);
  const finalState = await graph.invoke(start);
  return {
    runId,
    projectId: finalState.projectId,
    requestId: finalState.requestId,
    topic: finalState.topic,
    targetKeyword: finalState.targetKeyword,
    status: finalState.status,
    context: finalState.context,
    plan: finalState.plan,
    planStatus: finalState.planStatus,
    planNote: finalState.planNote,
  };
}
