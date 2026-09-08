/**
 * Writer Agent state model (W0-W2).
 *
 * A writer run is a small typed state machine that flows through the
 * LangGraph writer graph. The state carries run identity, the writer's brief
 * (topic / optional target keyword), the bounded, source-labelled context
 * gathered for it and, once planning has run, the proposed article plan. It
 * never carries secrets, credentials, service-role handles or raw database
 * rows - everything a phase needs is resolved inside a node through explicit
 * dependency boundaries and either ends up here as plain serializable data or
 * never enters the checkpoint at all.
 *
 * The identity channels (projectId, requestId) are protected by a reducer
 * that rejects any change after the run has been initialised, so a run can
 * never silently migrate to another project or request while in flight. The
 * status channel is guarded by an explicit transition table
 * (idle -> running -> planning -> awaiting_approval). That table is the
 * deny-by-default gatekeeper of the lifecycle: an illegal transition fails
 * the run instead of letting the state drift into a combination the rest of
 * the platform cannot read. context is bounded and labelled by the boundary
 * helpers in context.ts before it is written, and the plan that planOutline
 * produces is Zod-validated at the planner boundary before it is stored, so
 * no retrieval source or model reply can grow state without limit.
 *
 * The plan channels (planStatus / plan / planNote) keep the plan artifact
 * separate from the run lifecycle: a run that proposed a plan rests on
 * awaiting_approval with planStatus "proposed"; a run that could not produce
 * a plan (AI not configured, transport error, invalid output) ends failed
 * with planStatus "failed" and a bounded honest note - never a fabricated
 * fallback plan.
 */

import { Annotation } from '@langchain/langgraph';
import { emptyWriterContext, type WriterContext } from './context.js';

/** All statuses a writer run can ever be in; empty transition lists mean the
 *  run rests there (awaiting_approval is where W3 later resumes from). */
export const WRITER_STATUSES = [
  'idle',
  'running',
  'planning',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WriterStatus = (typeof WRITER_STATUSES)[number];

/** Legal one-step transitions between writer statuses; empty means the run
 *  rests there. completed becomes reachable again when W3 wires the
 *  post-approval writing phase; awaiting_approval gets its resume edges then
 *  too. */
export const STATUS_TRANSITIONS: Record<WriterStatus, readonly WriterStatus[]> = {
  idle: ['running'],
  running: ['planning'],
  planning: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: [],
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

/** Overwrite reducer for channels that are wholly replaced on each write. */
function replaceReducer<T>(_prev: T, next: T): T {
  return next;
}

// --- article plan artifact ------------------------------------------------
//
// The plan is the W2 output: a structural outline (never article body text,
// HTML or a full document). It is produced by the AI planner and validated
// against a Zod schema at the planner boundary before it reaches state, so a
// model reply can never grow state without limit. relatedContent is an
// internal, deterministic duplicate/cannibalization signal derived only from
// real existing-content rows gathered in W1 - never invented by the model.

/** Where a writer run's plan stands. */
export const WRITER_PLAN_STATUSES = ['none', 'proposed', 'failed'] as const;
export type WriterPlanStatus = (typeof WRITER_PLAN_STATUSES)[number];

/** A single planned section: its heading plus bounded content targets. */
export interface WriterSection {
  heading: string;
  keyPoints: string[];
  suggestedKeywords: string[];
}

/** An existing project article the new plan should stay distinct from. */
export interface WriterRelatedContent {
  title: string;
  slug: string | null;
  reason: string;
}

/** The structural article plan a successful planOutline run proposes. */
export interface WriterPlan {
  title: string;
  metaDescription: string | null;
  introductionPurpose: string;
  sections: WriterSection[];
  relatedContent?: WriterRelatedContent[];
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
  topic: Annotation<string>(),
  targetKeyword: Annotation<string | null>({ reducer: replaceReducer, default: () => null }),
  status: Annotation<WriterStatus>({ reducer: statusReducer, default: () => 'idle' }),
  context: Annotation<WriterContext>({ reducer: replaceReducer, default: () => emptyWriterContext() }),
  planStatus: Annotation<WriterPlanStatus>({ reducer: replaceReducer, default: () => 'none' }),
  plan: Annotation<WriterPlan | null>({ reducer: replaceReducer, default: () => null }),
  planNote: Annotation<string | null>({ reducer: replaceReducer, default: () => null }),
});

/** Full typed state a node receives. */
export type WriterState = typeof WriterStateAnnotation.State;
/** Partial typed state a node may return. */
export type WriterStateUpdate = typeof WriterStateAnnotation.Update;
