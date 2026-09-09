/**
 * Writer Agent runtime + resume surface (W3).
 *
 * W3 turns the resting awaiting_approval run into a real LangGraph interrupt:
 * a run stops at the awaitApproval node until an explicit approve/reject
 * decision resumes it. This module owns everything that happens *around* the
 * graph for that to work in-process:
 *
 *   - run id helpers: a writer run id (wr_<uuid>) is also the LangGraph
 *     thread id for that run, so starting and resuming always address the
 *     same checkpoint;
 *   - WriterRunRegistry: an in-memory map of runId -> compiled graph (which
 *     owns its MemorySaver checkpoint). The registry is module/service-level
 *     runtime infrastructure, not user-controlled state, and it is injectable
 *     so tests can isolate runs and exercise missing-run behaviour. It is
 *     intentionally process-local: it is the unit-test surface for the
 *     graph (W3-W5 tests drive runs through this registry). Durable W7 runs
 *     (durable.ts + WriterRunService) keep the checkpoint in Postgres through
 *     the checkpoint host and never register here;
 *   - resumeWriterRun: validates the runId + decision, denies anything that
 *     is not a registered run resting on awaiting_approval, then resumes the
 *     exact same thread with the validated decision. Approval only ever
 *     enters the graph through this boundary.
 *
 * deny-by-default rules enforced here:
 *   - runId not a writer run id                       -> 400 bad_request
 *   - decision outside the strict vocabulary          -> 400 invalid_approval_decision
 *   - no run registered for the runId (or no thread checkpoint for it) -> 404 writer_run_not_found
 *   - run exists but is not resting on awaiting_approval (already approved,
 *     rejected, failed, completed, ...)               -> 409 writer_run_not_awaiting_approval
 * Resuming never re-runs from START and never calls the planner again. An
 * approve resume continues the same run through the W4 writing phase and the
 * W5 deterministic review, resting on `review_ready` at the W8 review-session
 * interrupt with the canonical WriterReview artifact (never terminal); a reject
 * ends the run rejected. resumeWriterSession continues a review_ready run with
 * a validated session decision: accept -> completed (terminal) or revise -> the
 * controlled revision round back to a fresh review_ready rest.
 */

import { randomUUID } from 'node:crypto';
import { Command } from '@langchain/langgraph';
import { ApiError } from '../../apiErrors.js';
import type { WriterApprovalDecision } from './approval.js';
import { parseWriterApprovalDecision } from './approval.js';
import { parseWriterSessionDecision, type WriterSessionDecision } from './revision.js';
import { emptyWriterContext, type WriterContext } from './context.js';
import type {
  WriterApprovalStatus,
  WriterPlan,
  WriterPlanStatus,
  WriterReview,
  WriterReviewStatus,
  WriterRevisionStatus,
  WriterState,
  WriterStatus,
  WriterWrittenSection,
} from './state.js';
import type { CompiledWriterGraph } from './graph.js';

// --- run identity -----------------------------------------------------------

export const WRITER_RUN_ID_PREFIX = 'wr_';
/** Unique correlation id for a writer run; also the LangGraph thread id. */
export type WriterRunId = `${typeof WRITER_RUN_ID_PREFIX}${string}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Creates a fresh, unique writer run id. */
export function createWriterRunId(): WriterRunId {
  return `${WRITER_RUN_ID_PREFIX}${randomUUID()}`;
}

/** True when the value is a well-formed writer run id. */
export function isWriterRunId(value: unknown): value is WriterRunId {
  return typeof value === 'string' && value.startsWith(WRITER_RUN_ID_PREFIX) && UUID_RE.test(value.slice(WRITER_RUN_ID_PREFIX.length));
}

/** The LangGraph thread id for a writer run is the run id itself. */
export function writerRunThreadConfig(runId: WriterRunId): { configurable: { thread_id: string } } {
  return { configurable: { thread_id: runId } };
}

// --- result mapping ----------------------------------------------------------

/** Reads a possibly-still-unwritten defaulted channel off a graph invoke
 *  result (an interrupted result only carries channels written so far). */
function channel<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

/** Outcome of a writer run: the run id plus the resting state (identity,
 *  brief, the bounded context gatherContext produced, the planning outcome,
 *  the human approval state, the written sections, the canonical review
 *  artifact after a review round and the W8 revision counters). A proposed
 *  plan rests on awaiting_approval with approval "pending"; an approved run
 *  writes its sections, runs the deterministic review and rests on
 *  `review_ready` with a WriterReview (never terminal - the review session
 *  decides next); acceptance and honest failures are terminal. */
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
  approval: WriterApprovalStatus;
  approvalReason: string | null;
  writtenSections: WriterWrittenSection[];
  writeNote: string | null;
  /** Canonical review artifact, present only after a completed review round. */
  review: WriterReview | null;
  reviewStatus: WriterReviewStatus;
  reviewNote: string | null;
  /** Whether the last revision round is pending/active on the run. */
  revisionStatus: WriterRevisionStatus;
  /** Number of revision rounds this run has applied. */
  revisionCount: number;
  /** ISO timestamp of the most recent applied revision round, if any. */
  lastRevisionAt: string | null;
  /** Bounded, honest note of a failed revision round, if any. */
  revisionNote: string | null;
}

/** Maps raw graph state onto the public run result, tolerating channels the
 *  graph has not written yet (an interrupted run only surfaces what executed
 *  so far). */
export function writerRunResultFromState(runId: WriterRunId, state: WriterState): WriterRunResult {
  return {
    runId,
    projectId: channel(state.projectId, ''),
    requestId: channel(state.requestId, ''),
    topic: channel(state.topic, ''),
    targetKeyword: channel(state.targetKeyword, null),
    status: channel(state.status, 'idle'),
    context: channel(state.context, emptyWriterContext()),
    plan: channel(state.plan, null),
    planStatus: channel(state.planStatus, 'none'),
    planNote: channel(state.planNote, null),
    approval: channel(state.approval, 'pending'),
    approvalReason: channel(state.approvalReason, null),
    writtenSections: channel(state.writtenSections, []),
    writeNote: channel(state.writeNote, null),
    review: channel(state.review, null),
    reviewStatus: channel(state.reviewStatus, 'pending'),
    reviewNote: channel(state.reviewNote, null),
    revisionStatus: channel(state.revisionStatus, 'none'),
    revisionCount: channel(state.revisionCount, 0),
    lastRevisionAt: channel(state.lastRevisionAt, null),
    revisionNote: channel(state.revisionNote, null),
  };
}

// --- in-memory run registry --------------------------------------------------

/** In-memory registry keyed by writer run id. Each entry owns the compiled
 *  graph for that run, which in turn owns the run's MemorySaver checkpoint.
 *  Process-local on purpose: the unit-test surface for the graph. Durable W7
 *  runs live in Postgres via the checkpoint host and never use this registry. */
export interface WriterRunRegistry {
  /** Registers the compiled graph that owns a run's checkpoint. */
  register(runId: WriterRunId, graph: CompiledWriterGraph): void;
  /** The compiled graph for a run, if it was registered. */
  get(runId: WriterRunId): CompiledWriterGraph | undefined;
  /** Whether a run is registered. */
  has(runId: WriterRunId): boolean;
  /** Removes a run from the registry (e.g. after a terminal result is safe to
   *  drop). */
  delete(runId: WriterRunId): void;
  /** Number of registered runs. */
  size(): number;
}

/** Creates an empty run registry. Pass one explicitly to scope runs per test
 *  or per service instance; the default used by runWriterOnce/resumeWriterRun
 *  is a module-level instance. */
export function createWriterRunRegistry(): WriterRunRegistry {
  const runtimes = new Map<string, CompiledWriterGraph>();
  return {
    register(runId, graph) {
      runtimes.set(runId, graph);
    },
    get(runId) {
      return runtimes.get(runId);
    },
    has(runId) {
      return runtimes.has(runId);
    },
    delete(runId) {
      runtimes.delete(runId);
    },
    size() {
      return runtimes.size;
    },
  };
}

/** Module-level default registry so the public one-shot API
 *  (runWriterOnce -> resumeWriterRun) works without plumbing a registry. Runs
 *  are process-local: a restart clears this and every resume then fails with
 *  writer_run_not_found - honest, never a silent restart from START. */
const defaultRegistry = createWriterRunRegistry();

/** Returns the shared default registry instance. */
export function defaultWriterRunRegistry(): WriterRunRegistry {
  return defaultRegistry;
}

/** Validation errors for a resume attempt; the message carries everything a
 *  route handler needs to turn this into a typed { error } response later. */

// --- resume -------------------------------------------------------------------

/** Strictly validates and resumes a run paused on awaiting_approval with the
 *  exact same thread/checkpoint that ran its start. See module docs for the
 *  deny-by-default rules; this function never re-runs from START and never
 *  triggers any AI or provider call. */
export async function resumeWriterRun(
  input: { runId: WriterRunId; decision: WriterApprovalDecision },
  registry: WriterRunRegistry = defaultRegistry,
): Promise<WriterRunResult> {
  const { runId, decision } = input;
  if (!isWriterRunId(runId)) {
    throw ApiError.badRequest('runId must be a writer run id (wr_<uuid>)', { runId });
  }
  const parsed = parseWriterApprovalDecision(decision);
  if (!parsed.ok) {
    throw new ApiError(400, 'invalid_approval_decision', parsed.note, { runId });
  }

  const graph = registry.get(runId);
  if (!graph) {
    throw new ApiError(
      404,
      'writer_run_not_found',
      'No writer run is registered for this runId. Writer runs live in memory and do not survive a process restart.',
      { runId },
    );
  }

  const snapshot = await graph.getState(writerRunThreadConfig(runId));
  const status = (snapshot.values as { status?: WriterStatus }).status;
  if (!status) {
    throw new ApiError(
      404,
      'writer_run_not_found',
      'No writer run checkpoint exists for this runId.',
      { runId },
    );
  }
  if (status !== 'awaiting_approval') {
    throw new ApiError(
      409,
      'writer_run_not_awaiting_approval',
      `Writer run ${runId} is ${status}; only a run awaiting approval can be resumed.`,
      { runId, status },
    );
  }

  const finalState = await graph.invoke(new Command({ resume: parsed.decision }), writerRunThreadConfig(runId));
  return writerRunResultFromState(runId, finalState);
}

/**
 * Strictly validates and resumes a run paused on the W8 review session
 * (review_ready) with the exact same thread/checkpoint that ran its start. An
 * accept moves the run to `completed` (terminal); a revise runs the controlled
 * revision round (revising -> reviewing -> review_ready) synchronously on this
 * resume and rests again on `review_ready` with the fresh artifact. Deny-by-
 * default rules mirror resumeWriterRun: an invalid session decision is 400
 * invalid_review_session_decision, a missing run is 404 writer_run_not_found
 * and a run not resting on review_ready is 409 writer_run_not_review_ready.
 */
export async function resumeWriterSession(
  input: { runId: WriterRunId; decision: WriterSessionDecision },
  registry: WriterRunRegistry = defaultRegistry,
): Promise<WriterRunResult> {
  const { runId, decision } = input;
  if (!isWriterRunId(runId)) {
    throw ApiError.badRequest('runId must be a writer run id (wr_<uuid>)', { runId });
  }
  const parsed = parseWriterSessionDecision(decision);
  if (!parsed.ok) {
    throw new ApiError(400, 'invalid_review_session_decision', parsed.note, { runId });
  }

  const graph = registry.get(runId);
  if (!graph) {
    throw new ApiError(
      404,
      'writer_run_not_found',
      'No writer run is registered for this runId. Writer runs live in memory and do not survive a process restart.',
      { runId },
    );
  }

  const snapshot = await graph.getState(writerRunThreadConfig(runId));
  const status = (snapshot.values as { status?: WriterStatus }).status;
  if (!status) {
    throw new ApiError(
      404,
      'writer_run_not_found',
      'No writer run checkpoint exists for this runId.',
      { runId },
    );
  }
  if (status !== 'review_ready') {
    throw new ApiError(
      409,
      'writer_run_not_review_ready',
      `Writer run ${runId} is ${status}; only a run resting on review_ready can accept or revise.`,
      { runId, status },
    );
  }

  const finalState = await graph.invoke(new Command({ resume: parsed.decision }), writerRunThreadConfig(runId));
  return writerRunResultFromState(runId, finalState);
}
