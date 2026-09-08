/**
 * Writer Agent public surface (W0-W3).
 *
 * runWriterOnce is the only supported way to start a writer run. It validates
 * run identifiers and the writer brief at the boundary (invalid input is
 * rejected before the graph is touched), builds a fresh compiled graph with
 * the injected read-only context adapters and AI planner and runs it on a
 * thread identified by the writer run id (wr_<uuid>). When planning proposes
 * a plan the graph now pauses on the W3 human-approval interrupt; the
 * returned result rests on awaiting_approval with approval "pending".
 *
 * resumeWriterRun is the only supported way to continue a paused run. It
 * looks the run up in the same in-memory WriterRunRegistry (runId ->
 * compiled graph owning that run's MemorySaver checkpoint), strictly
 * validates the approve/reject decision and resumes the exact same thread.
 * Runs are process-local: a restart loses the registry, and resuming a lost
 * run then fails honestly with writer_run_not_found - never a silent restart
 * from START. W8 replaces the registry/checkpointer with durable storage
 * behind this same runId -> resume surface.
 */

import { ApiError } from '../../apiErrors.js';
import { emptyWriterContext, type WriterContextDependencies } from './context.js';
import { createWriterGraph } from './graph.js';
import type { WriterPlannerDependencies } from './planner.js';
import {
  createWriterRunId,
  defaultWriterRunRegistry,
  isWriterRunId,
  writerRunResultFromState,
  type WriterRunId,
  type WriterRunRegistry,
  type WriterRunResult,
} from './runtime.js';
import type { WriterState } from './state.js';

export { createWriterGraph, WRITER_APPROVAL_NODE, WRITER_GATHER_NODE, WRITER_INITIALIZE_NODE, WRITER_PLAN_NODE } from './graph.js';
export * from './approval.js';
export * from './context.js';
export * from './planner.js';
export {
  createWriterRunId,
  createWriterRunRegistry,
  isWriterRunId,
  resumeWriterRun,
  writerRunResultFromState,
  WRITER_RUN_ID_PREFIX,
  type WriterRunId,
  type WriterRunRegistry,
  type WriterRunResult,
} from './runtime.js';
export {
  STATUS_TRANSITIONS,
  WRITER_APPROVAL_STATUSES,
  WRITER_STATUSES,
  WriterStateAnnotation,
  assertStatusTransition,
  type WriterApprovalStatus,
  type WriterPlan,
  type WriterPlanStatus,
  type WriterRelatedContent,
  type WriterSection,
  type WriterState,
  type WriterStateUpdate,
  type WriterStatus,
} from './state.js';

/** Longest accepted topic for a writer run. */
export const WRITER_MAX_TOPIC_CHARS = 500;
/** Longest accepted target keyword for a writer run. */
export const WRITER_MAX_TARGET_KEYWORD_CHARS = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Upper bound on caller-supplied request ids (kept tiny on purpose). */
const MAX_REQUEST_ID_LENGTH = 200;

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
    approval: 'pending',
    approvalReason: null,
  };
}

/**
 * Runs the writer graph once for a validated request and returns the resting
 * state. Context adapters and the AI planner are optional: without them every
 * source reports not configured and planning reports "no AI planner wired",
 * ending the run failed instead of fabricating a plan. Throws
 * ApiError.badRequest for malformed input; genuine run failures surface from
 * the graph.
 *
 * When the run proposes a plan it pauses on the human approval interrupt and
 * is registered under its runId in the supplied (or a fresh) in-memory run
 * registry so resumeWriterRun can continue the exact same thread later. Pass
 * one explicit registry to scope runs per service instance / test.
 */
export async function runWriterOnce(
  input: WriterRunRequest,
  deps: WriterRunDependencies = {},
  registry: WriterRunRegistry = defaultWriterRunRegistry(),
): Promise<WriterRunResult> {
  const start = parseWriterRunRequest(input);
  const runId = input.runId ?? createWriterRunId();
  const graph = createWriterGraph(deps);
  const restingState = await graph.invoke(start, { configurable: { thread_id: runId } });
  const result = writerRunResultFromState(runId, restingState);
  if (result.status === 'awaiting_approval') {
    registry.register(runId, graph);
  }
  return result;
}
