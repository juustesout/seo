/**
 * Writer Agent state model (W0 foundation).
 *
 * A writer run is a small typed state machine that flows through the
 * LangGraph writer graph. The state only carries run identity and a coarse
 * lifecycle status - no secrets, no credentials, no service-role handles and
 * no raw database rows. Everything a later phase needs is resolved inside a
 * node through the existing service boundaries and either ends up here as
 * plain serializable data or never enters the checkpoint at all.
 *
 * The identity channels (projectId, requestId) are protected by a reducer
 * that rejects any change after the run has been initialised, so a run can
 * never silently migrate to another project or request while in flight. The
 * status channel is guarded by an explicit transition table
 * (idle -> running -> terminal). That table is the deny-by-default gatekeeper
 * for the lifecycle: an illegal transition fails the run instead of letting
 * the state drift into a combination the rest of the platform cannot read.
 */

import { Annotation } from '@langchain/langgraph';

/** All statuses a writer run can ever be in; terminal states never leave. */
export const WRITER_STATUSES = ['idle', 'running', 'completed', 'failed', 'cancelled'] as const;
export type WriterStatus = (typeof WRITER_STATUSES)[number];

/** Legal one-step transitions between writer statuses; empty means terminal. */
export const STATUS_TRANSITIONS: Record<WriterStatus, readonly WriterStatus[]> = {
  idle: ['running'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * Validates a single status change against the transition table. An equal
 * value is allowed (a no-op write), any other non-listed move throws - the
 * throw is what makes an illegal transition fail the graph run.
 */
export function assertStatusTransition(prev: WriterStatus, next: WriterStatus): void {
  if (prev === next) return;
  if (!STATUS_TRANSITIONS[prev].includes(next)) {
    throw new Error(`Invalid writer status transition: ${prev} -> ${next}`);
  }
}

/** Reducer for identity fields: a run keeps the project/request it started with. */
function immutableStringReducer(prev: string, next: string): string {
  if (prev !== next) {
    throw new Error(`Immutable writer state field changed from "${prev}" to "${next}"`);
  }
  return prev;
}

function statusReducer(prev: WriterStatus, next: WriterStatus): WriterStatus {
  assertStatusTransition(prev, next);
  return next;
}

/**
 * The single state definition for every writer graph. Reducers run on every
 * write (including the initial invoke input), so channel construction already
 * encodes the identity + lifecycle invariants; graph nodes cannot bypass
 * them without failing the run.
 */
export const WriterStateAnnotation = Annotation.Root({
  projectId: Annotation<string>({ reducer: immutableStringReducer }),
  requestId: Annotation<string>({ reducer: immutableStringReducer }),
  status: Annotation<WriterStatus>({ reducer: statusReducer, default: () => 'idle' }),
});

/** Full typed state a node receives. */
export type WriterState = typeof WriterStateAnnotation.State;
/** Partial typed state a node may return. */
export type WriterStateUpdate = typeof WriterStateAnnotation.Update;
