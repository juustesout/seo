/**
 * Durable writer run surface (W7).
 *
 * The one-shot APIs in index.ts/runtime.ts keep their compiled graph in an
 * in-memory registry because they default to a per-graph MemorySaver - resume
 * only works against that exact object. Durable runs instead share ONE
 * checkpointer (the process-wide PostgresSaver from writerCheckpointHost, or a
 * shared MemorySaver fallback), keyed by the run id/thread id. Because any
 * freshly compiled graph on that checkpointer can read and continue a thread,
 * no registry is needed and a run that survived a restart is resumable by a
 * graph compiled after the restart.
 *
 * These functions implement the same deny-by-default rules as
 * resumeWriterRun, with the durable checkpointer as the source of truth:
 *
 *   - startDurableWriterRun   compiles a fresh graph on the shared
 *     checkpointer and runs the initial thread once (pauses on the W3 human
 *     approval interrupt, or ends failed);
 *   - resumeDurableWriterRun  reads the thread state first and only resumes an
 *     awaiting_approval thread with the validated decision; a missing thread
 *     is writer_run_not_found, a non-awaiting thread is
 *     writer_run_not_awaiting_approval - it never re-runs from START and never
 *     calls the planner again;
 *   - resumeDurableReviewSession is the W8 equivalent for a thread resting on
 *     the review-session interrupt (`review_ready`): it only resumes such a
 *     thread with a validated review-session decision (accept -> completed,
 *     revise -> the revision loop), never any other thread - a non-review_ready
 *     thread is writer_run_not_review_ready;
 *   - continueDurableWriterRun recovers a run whose row says it is mid-writing
 *     or mid-revision after a restart (an approve/revise was already committed).
 *     It reads the thread: awaiting_approval means the approve Command never
 *     ran (crash right after the DB transition) and is re-issued; a review_ready
 *     thread whose revise was committed but never resumed (its state shows no
 *     revision in progress) is re-issued from the supplied review-session
 *     resume, while a review_ready thread that already finished is reported so
 *     the row can catch up; a resting terminal thread is reported so the row
 *     can catch up; a thread with pending writing/revision supersteps is
 *     continued with a null input, which resumes only the pending tasks from
 *     the last persisted checkpoint - already-written/rewritten sections are
 *     not redone (each section is its own persisted superstep, see graph
 *     writeSectionsNode/reviseSectionsNode). A run with no checkpoint at all
 *     returns null so the caller can fail it honestly instead of inventing one.
 */

import { Command, type BaseCheckpointSaver } from '@langchain/langgraph';
import { ApiError } from '../../apiErrors.js';
import { parseWriterApprovalDecision } from './approval.js';
import { createWriterGraph } from './graph.js';
import type { CompiledWriterGraph } from './graph.js';
import type { WriterRunDependencies, WriterRunRequest } from './index.js';
import { parseWriterRunRequest } from './index.js';
import { parseReviewSessionResume, type WriterReviewSessionResume } from './magic.js';
import {
  createWriterRunId,
  isWriterRunId,
  writerRunResultFromState,
  writerRunThreadConfig,
  type WriterRunId,
  type WriterRunResult,
} from './runtime.js';
import type { WriterRevisionStatus, WriterStatus } from './state.js';
import type { WriterAgentState } from './agent.js';

/** Compiles a fresh writer graph that shares the process-wide checkpointer. */
export function compileWriterGraph(
  deps: WriterRunDependencies,
  checkpointer: BaseCheckpointSaver,
): CompiledWriterGraph {
  return createWriterGraph({ ...deps, checkpointer });
}

/** Reads the resting status of a thread, or null when no checkpoint exists. */
async function restingStatus(graph: CompiledWriterGraph, runId: WriterRunId): Promise<WriterStatus | null> {
  const snapshot = await graph.getState(writerRunThreadConfig(runId));
  const status = (snapshot.values as { status?: WriterStatus }).status;
  return status ?? null;
}/** Starts a writer run on the shared durable checkpointer and returns its
 *  resting result (awaiting_approval with the proposed plan, or failed). */
export async function startDurableWriterRun(
  input: WriterRunRequest,
  deps: WriterRunDependencies,
  checkpointer: BaseCheckpointSaver,
): Promise<WriterRunResult> {
  const start = parseWriterRunRequest(input);
  const runId = input.runId ?? createWriterRunId();
  const graph = compileWriterGraph(deps, checkpointer);
  const restingState = await graph.invoke(start, writerRunThreadConfig(runId));
  return writerRunResultFromState(runId, restingState);
}

/** Strictly validates and resumes an awaiting_approval thread on the shared
 *  durable checkpointer with the validated decision. See module docs for the
 *  deny-by-default rules; this never re-runs from START and never calls the
 *  planner or any provider. */
export async function resumeDurableWriterRun(
  input: { runId: WriterRunId; decision: unknown },
  deps: WriterRunDependencies,
  checkpointer: BaseCheckpointSaver,
): Promise<WriterRunResult> {
  const { runId } = input;
  if (!isWriterRunId(runId)) {
    throw ApiError.badRequest('runId must be a writer run id (wr_<uuid>)', { runId });
  }
  const parsed = parseWriterApprovalDecision(input.decision);
  if (!parsed.ok) {
    throw new ApiError(400, 'invalid_approval_decision', parsed.note, { runId });
  }

  const graph = compileWriterGraph(deps, checkpointer);
  const status = await restingStatus(graph, runId);
  if (!status) {
    throw new ApiError(
      404,
      'writer_run_not_found',
      'No writer run checkpoint exists for this runId; the run cannot be resumed.',
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
 * Strictly validates and resumes a review_ready thread on the shared durable
 * checkpointer with a validated review-session resume (accept -> completed;
 * revise or a W10.1 magic resume -> the revision round through review_ready).
 * Mirrors resumeDurableWriterRun: a missing thread is writer_run_not_found, a
 * thread not resting on `review_ready` is writer_run_not_review_ready, an
 * invalid resume is invalid_review_session_decision. It never re-runs from
 * START, never calls the planner and never lets anything but the validated
 * session resume steer the run.
 */
export async function resumeDurableReviewSession(
  input: { runId: WriterRunId; decision: unknown },
  deps: WriterRunDependencies,
  checkpointer: BaseCheckpointSaver,
): Promise<WriterRunResult> {
  const { runId } = input;
  if (!isWriterRunId(runId)) {
    throw ApiError.badRequest('runId must be a writer run id (wr_<uuid>)', { runId });
  }
  const parsed = parseReviewSessionResume(input.decision);
  if (!parsed.ok) {
    throw new ApiError(400, 'invalid_review_session_decision', parsed.note, { runId });
  }

  const graph = compileWriterGraph(deps, checkpointer);
  const status = await restingStatus(graph, runId);
  if (!status) {
    throw new ApiError(
      404,
      'writer_run_not_found',
      'No writer run checkpoint exists for this runId; the run cannot be resumed.',
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

  const finalState = await graph.invoke(new Command({ resume: parsed.resume }), writerRunThreadConfig(runId));
  return writerRunResultFromState(runId, finalState);
}

/**
 * Continues a writer run whose durable row is mid-writing or mid-revision after
 * a restart. See module docs. Returns the resting result, or null when no
 * checkpoint exists for the thread (the caller fails the run honestly).
 *
 * opts.reviewSessionResume is supplied when recovering a `revising` row: if the
 * thread turns out to still be resting on the review session with no revision
 * in progress, the committed revise resume never executed (crash between the DB
 * transition and the invoke) and is re-issued so the revision is not lost.
 */
export async function continueDurableWriterRun(
  runId: WriterRunId,
  deps: WriterRunDependencies,
  checkpointer: BaseCheckpointSaver,
  opts: { reviewSessionResume?: WriterReviewSessionResume; agentResume?: WriterReviewSessionResume } = {},
): Promise<WriterRunResult | null> {
  const graph = compileWriterGraph(deps, checkpointer);
  const config = writerRunThreadConfig(runId);
  const current = await graph.getState(config);
  const values = current.values as {
    status?: WriterStatus;
    revisionStatus?: WriterRevisionStatus;
    agent?: WriterAgentState | null;
  };
  const status = values.status;
  if (!status) return null;

  if (status === 'awaiting_approval') {
    // An approve was committed (the row moved to writing) but its Command
    // resume never executed (crash between the DB transition and the invoke).
    // Re-issue the approve so the run proceeds instead of hanging mid-writing.
    const finalState = await graph.invoke(new Command({ resume: { decision: 'approve' } }), config);
    return writerRunResultFromState(runId, finalState);
  }
  if (status === 'review_ready' && values.agent?.status === 'running') {
    // A W10.4 agent loop is mid-flight (a consumed superstep was persisted but
    // the loop had not finished): continue the pending supersteps only, so no
    // already-committed agent step is re-run.
    const finalState = await graph.invoke(null, config);
    return writerRunResultFromState(runId, finalState);
  }
  if (status === 'review_ready' && opts.agentResume && !values.agent) {
    // An agent start was committed (the row snapshot says `running`) but its
    // Command resume never executed (crash between the commit and the invoke).
    // Re-issue the exact validated agent resume so the run is not lost.
    const finalState = await graph.invoke(new Command({ resume: opts.agentResume }), config);
    return writerRunResultFromState(runId, finalState);
  }
  if (status === 'review_ready' && opts.reviewSessionResume && values.revisionStatus === 'none') {
    // A revise was committed (the row moved to revising) but its resume Command
    // never executed (crash between the DB transition and the invoke). Re-issue
    // the exact validated revise so the requested sections are still rewritten.
    const finalState = await graph.invoke(new Command({ resume: opts.reviewSessionResume }), config);
    return writerRunResultFromState(runId, finalState);
  }
  if (status === 'completed' || status === 'failed' || status === 'rejected' || status === 'review_ready') {
    // Resting terminal or review-session thread whose row has not caught up
    // (crash between the final checkpoint and the DB transition): report it so
    // the caller can persist it, never re-run it.
    return writerRunResultFromState(runId, current.values);
  }
  // Mid-writing/mid-revision/review with pending supersteps: resume the exact
  // same thread from its last persisted checkpoint. A null input continues
  // pending tasks only - persisted sections are never rewritten (each is its
  // own superstep).
  const finalState = await graph.invoke(null, config);
  return writerRunResultFromState(runId, finalState);
}
