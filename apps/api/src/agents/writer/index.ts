/**
 * Writer Agent public surface (W0-W5).
 *
 * runWriterOnce is the only supported way to start a writer run. It validates
 * run identifiers and the writer brief at the boundary (invalid input is
 * rejected before the graph is touched), builds a fresh compiled graph with
 * the injected read-only context adapters, AI planner, section writer and
 * deterministic review allowlist, and runs it on a thread identified by the
 * writer run id (wr_<uuid>). When planning proposes a plan the graph pauses
 * on the W3 human-approval interrupt; the returned result rests on
 * awaiting_approval with approval "pending". No section is ever written before
 * that approval.
 *
 * resumeWriterRun is the in-process way to continue a paused run: it looks the
 * run up in the in-memory WriterRunRegistry (runId -> compiled graph owning
 * that run's MemorySaver checkpoint), strictly validates the approve/reject
 * decision and resumes the exact same thread. An approve continues through the
 * W4 writing phase (one AI call per approved section) and the W5 deterministic
 * review, resting on `review_ready` at the W8 review-session interrupt with a
 * canonical WriterReview artifact (content_json / content_html / full SeoResult
 * from the existing pipeline); a reject ends the run rejected with no writing.
 * resumeWriterSession continues a review_ready run with a validated session
 * decision - accept -> `completed` (the explicit save-finalization) or revise ->
 * the controlled revision round (revising -> reviewing -> review_ready).
 *
 * These in-memory helpers are the unit-test surface for the graph. Production
 * runs are durable (W7): WriterRunService persists each run to seo_writer_runs
 * and keeps the LangGraph checkpoint in Postgres through the checkpoint host,
 * then resumes through durable.ts - the same runId -> resume shape, but the
 * registry/checkpointer no longer loses runs on a restart.
 */

import { ApiError } from '../../apiErrors.js';
import { emptyWriterContext, type WriterContextDependencies } from './context.js';
import { createWriterGraph } from './graph.js';
import type { WriterPlannerDependencies } from './planner.js';
import type { WriterReviewDependencies } from './review.js';
import type { WriterRevisionDependencies } from './revisionWriter.js';
import type { WriterSectionDependencies } from './sectionWriter.js';
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

export {
  createWriterGraph,
  WRITER_APPROVAL_NODE,
  WRITER_BEGIN_WRITING_NODE,
  WRITER_GATHER_NODE,
  WRITER_INITIALIZE_NODE,
  WRITER_PLAN_NODE,
  WRITER_REVIEW_NODE,
  WRITER_REVIEW_SESSION_NODE,
  WRITER_REVISE_SECTIONS_NODE,
  WRITER_WRITE_SECTIONS_NODE,
} from './graph.js';
export * from './approval.js';
export * from './context.js';
export * from './planner.js';
export * from './review.js';
export * from './revision.js';
export * from './revisionWriter.js';
export * from './sectionWriter.js';
export {
  createWriterRunId,
  createWriterRunRegistry,
  isWriterRunId,
  resumeWriterRun,
  resumeWriterSession,
  writerRunResultFromState,
  WRITER_RUN_ID_PREFIX,
  type WriterRunId,
  type WriterRunRegistry,
  type WriterRunResult,
} from './runtime.js';
export {
  STATUS_TRANSITIONS,
  WRITER_APPROVAL_STATUSES,
  WRITER_REVIEW_STATUSES,
  WRITER_REVISION_STATUSES,
  WRITER_STATUSES,
  WriterStateAnnotation,
  assertStatusTransition,
  writerSectionIdFor,
  writerSectionIndexFor,
  type WriterApprovalStatus,
  type WriterPlan,
  type WriterPlanStatus,
  type WriterRelatedContent,
  type WriterReview,
  type WriterReviewStatus,
  type WriterRevisionRequest,
  type WriterRevisionStatus,
  type WriterSection,
  type WriterState,
  type WriterStateUpdate,
  type WriterStatus,
  type WriterWrittenSection,
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

/** Injectable seams for a writer run: the read-only context adapters, the AI
 *  planner, the section writer, the revision writer and the deterministic
 *  review allowlist. Each is optional; without one the matching capability
 *  reports itself not wired and the run degrades honestly (the review allowlist
 *  defaults to the canonical @seo/contracts evaluator + renderer). */
export interface WriterRunDependencies {
  context?: WriterContextDependencies;
  planner?: WriterPlannerDependencies;
  sectionWriter?: WriterSectionDependencies;
  revisionWriter?: WriterRevisionDependencies;
  review?: WriterReviewDependencies;
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
    writtenSections: [],
    writeNote: null,
    review: null,
    reviewStatus: 'pending',
    reviewNote: null,
    revisionStatus: 'none',
    revisionRequest: null,
    revisionNote: null,
    revisionProgress: [],
    revisionCount: 0,
    lastRevisionAt: null,
  };
}

/**
 * Runs the writer graph once for a validated request and returns the resting
 * state. Context adapters, the AI planner and the section writer are optional:
 * without them every source reports not configured, planning reports "no AI
 * planner wired" and an approved run's writing reports "no section writer
 * wired", ending the run failed instead of fabricating a plan or a section.
 * The deterministic review allowlist defaults to the canonical pipeline, so a
 * fully written run flows into W5 review and rests on `completed`. Throws
 * ApiError.badRequest for malformed input; genuine run failures surface from
 * the graph.
 *
 * When the run proposes a plan it pauses on the human approval interrupt and
 * is registered under its runId in the supplied (or a fresh) in-memory run
 * registry so resumeWriterRun can continue the exact same thread later. Pass
 * one explicit registry to scope runs per service instance / test. Nothing is
 * written before an explicit approve resume.
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
