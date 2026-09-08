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
 *   - continueDurableWriterRun recovers a run whose row says it is mid-writing
 *     after a restart (an approve was already committed). It reads the thread:
 *     awaiting_approval means the approve Command never ran (crash right after
 *     the DB transition) and is re-issued; a resting terminal thread is
 *     reported so the row can catch up; a thread with pending writing
 *     supersteps is continued with a null input, which resumes only the
 *     pending tasks from the last persisted checkpoint - already-written
 *     sections are not rewritten (each section is its own persisted superstep,
 *     see graph writeSectionsNode). A run with no checkpoint at all returns
 *     null so the caller can fail it honestly instead of inventing one.
 */

import { Command, type BaseCheckpointSaver } from '@langchain/langgraph';
import { ApiError } from '../../apiErrors.js';
import { parseWriterApprovalDecision } from './approval.js';
import { createWriterGraph } from './graph.js';
import type { CompiledWriterGraph } from './graph.js';
import type { WriterRunDependencies, WriterRunRequest } from './index.js';
import { parseWriterRunRequest } from './index.js';
import {
  createWriterRunId,
  isWriterRunId,
  writerRunResultFromState,
  writerRunThreadConfig,
  type WriterRunId,
  type WriterRunResult,
} from './runtime.js';
import type { WriterStatus } from './state.js';

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
}

/** Starts a writer run on the shared durable checkpointer and returns its
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
 * Continues a writer run whose durable row is mid-writing after a restart. See
 * module docs. Returns the resting result, or null when no checkpoint exists
 * for the thread (the caller fails the run honestly).
 */
export async function continueDurableWriterRun(
  runId: WriterRunId,
  deps: WriterRunDependencies,
  checkpointer: BaseCheckpointSaver,
): Promise<WriterRunResult | null> {
  const graph = compileWriterGraph(deps, checkpointer);
  const status = await restingStatus(graph, runId);
  if (!status) return null;

  const config = writerRunThreadConfig(runId);
  if (status === 'awaiting_approval') {
    // An approve was committed (the row moved to writing) but its Command
    // resume never executed (crash between the DB transition and the invoke).
    // Re-issue the approve so the run proceeds instead of hanging mid-writing.
    const finalState = await graph.invoke(new Command({ resume: { decision: 'approve' } }), config);
    return writerRunResultFromState(runId, finalState);
  }
  if (status === 'completed' || status === 'failed' || status === 'rejected') {
    // Resting terminal thread whose row has not caught up (crash between the
    // final checkpoint and the DB transition): report it so the caller can
    // persist it, never re-run it.
    const current = await graph.getState(config);
    return writerRunResultFromState(runId, current.values);
  }
  // Mid-writing/review with pending supersteps: resume the exact same thread
  // from its last persisted checkpoint. A null input continues pending tasks
  // only - persisted sections are never rewritten (each is its own superstep).
  const finalState = await graph.invoke(null, config);
  return writerRunResultFromState(runId, finalState);
}
