/**
 * Writer Agent state model (W0-W5).
 *
 * A writer run is a small typed state machine that flows through the
 * LangGraph writer graph. The state carries run identity, the writer's brief
 * (topic / optional target keyword), the bounded, source-labelled context
 * gathered for it, the proposed article plan, the approved section contents
 * written against it and, once W5 review has run, the canonical review
 * artifact. It never carries secrets, credentials, service-role handles or raw
 * database rows - everything a phase needs is resolved inside a node through
 * explicit dependency boundaries and either ends up here as plain serializable
 * data or never enters the checkpoint at all.
 *
 * The identity channels (projectId, requestId) are protected by a reducer
 * that rejects any change after the run has been initialised, so a run can
 * never silently migrate to another project or request while in flight. The
 * status channel is guarded by an explicit transition table
 * (idle -> running -> planning -> awaiting_approval -> approved -> writing ->
 * review_ready -> completed, with honest failed exits at each step). That
 * table is the deny-by-default gatekeeper of the lifecycle: an illegal
 * transition fails the run instead of letting the state drift into a
 * combination the rest of the platform cannot read. context is bounded and
 * labelled by the boundary helpers in context.ts before it is written, and the
 * plan that planOutline produces is Zod-validated at the planner boundary
 * before it is stored, so no retrieval source or model reply can grow state
 * without limit.
 *
 * The plan channels (planStatus / plan / planNote) keep the plan artifact
 * separate from the run lifecycle: a run that proposed a plan rests on
 * awaiting_approval with planStatus "proposed"; a run that could not produce
 * a plan (AI not configured, transport error, invalid output) ends failed
 * with planStatus "failed" and a bounded honest note - never a fabricated
 * fallback plan.
 *
 * W3 adds the human approval gate. A proposed plan pauses the graph at
 * awaitApproval (LangGraph interrupt) instead of ending it; the run rests on
 * awaiting_approval with the approval channel at "pending" until an explicit,
 * validated resume decision moves it to approved or rejected. The approval
 * value only ever comes from that validated resume input - never from AI,
 * context or the prompt - and approvalReason carries the bounded, optional
 * human note attached to a rejection. rejection is terminal (END).
 *
 * W4 adds the controlled writing phase that only ever runs after approval.
 * approve continues the same graph run through beginWriting (writing) into
 * writeSections, which writes the approved sections one AI call per section,
 * strictly in the plan order, with the outline itself held immutable by the
 * graph. Each written section (WriterWrittenSection) stores its deterministic
 * section id (a zero-based index into the approved plan) plus the AI content;
 * the code guarantees every written section maps to exactly one approved
 * section and that no section is written twice. Success then flows into W5.
 *
 * W5 adds the deterministic review and content-assembly phase. reviewContent
 * is a pure, local pipeline: it reassembles the written sections into one
 * canonical Content Studio document (in approved plan order, from the approved
 * plan title/headings and the written bodies only), renders the canonical
 * content_html through the existing renderer and scores it with the existing
 * Phase C SEO evaluator. It makes no AI call, writes nothing and stores the
 * result as a WriterReview artifact under the review channel with
 * reviewStatus "completed". The run then rests on `completed` - the writer has
 * produced a review-ready canonical artifact, not a saved article. `completed`
 * is only reached through a successful review; any honest review failure
 * (missing/extra section, invalid content, render/evaluate error) ends the run
 * failed with reviewStatus "failed" and a bounded note. A failed run keeps
 * whatever plan and written sections it honestly produced.
 */

import { Annotation } from '@langchain/langgraph';
import type { SeoResult, TipDoc } from '@seo/contracts';
import { emptyWriterContext, type WriterContext } from './context.js';

/** All statuses a writer run can ever be in; empty transition lists mean the
 *  run rests there (completed / rejected / failed are terminal). completed is
 *  reached only through the W5 review phase: the writer produced one canonical
 *  review artifact, not a saved article. awaiting_approval pauses on the human
 *  approval interrupt and is left only through an explicit approve/reject
 *  resume. */
export const WRITER_STATUSES = [
  'idle',
  'running',
  'planning',
  'awaiting_approval',
  'approved',
  'writing',
  'review_ready',
  'rejected',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WriterStatus = (typeof WRITER_STATUSES)[number];

/** Where the human approval gate stands: pending until an explicit resume
 *  decision resolves it to approved or rejected. */
export const WRITER_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type WriterApprovalStatus = (typeof WRITER_APPROVAL_STATUSES)[number];

/** Where the W5 deterministic review stands. pending until reviewContent runs;
 *  completed only after it produced a canonical review artifact; failed on any
 *  honest review failure. Independent of the run lifecycle status. */
export const WRITER_REVIEW_STATUSES = ['pending', 'completed', 'failed'] as const;
export type WriterReviewStatus = (typeof WRITER_REVIEW_STATUSES)[number];

/** Legal one-step transitions between writer statuses; empty means the run
 *  rests there (completed / rejected / failed are terminal). approved -> writing
 *  -> review_ready -> completed is the code-owned W4+W5 path that starts only
 *  after an explicit approval: writing fills the approved sections and the
 *  deterministic review phase assembles the canonical document. awaiting_approval
 *  -> failed exists so a run whose resume input cannot be validated degrades
 *  honestly instead of hanging; writing/review_ready -> failed let an honest
 *  section or review failure stop the run. */
export const STATUS_TRANSITIONS: Record<WriterStatus, readonly WriterStatus[]> = {
  idle: ['running'],
  running: ['planning'],
  planning: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['approved', 'rejected', 'failed'],
  approved: ['writing'],
  writing: ['review_ready', 'failed'],
  review_ready: ['completed', 'failed'],
  rejected: [],
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

// --- written sections artifact (W4) ----------------------------------------
//
// The writing phase fills the approved outline in place: the outline itself
// (headings, order, key points, keywords) is code-owned and immutable, and the
// AI writes only the body content of each approved section, one call per
// section. A written section references the approved plan by a deterministic,
// zero-based section id and stores the generated content. It never carries the
// heading, key points or keywords - those come from the plan, never from AI.

/** Deterministic id of the n-th approved plan section (zero-based). */
export function writerSectionIdFor(index: number): string {
  return `section_${index}`;
}

/** One section of article body content, keyed to exactly one approved plan
 *  section (by deterministic section id). */
export interface WriterWrittenSection {
  sectionId: string;
  content: string;
}

// --- review artifact (W5) ----------------------------------------------------
//
// The W5 review phase is a deterministic, local conveyor: it reassembles the
// written sections into ONE canonical Content Studio document (from the
// approved plan title/headings and the written bodies, strictly in plan
// order), renders content_html through the existing canonical renderer and
// scores it with the existing Phase C SEO evaluator. The artifact reuses the
// canonical contracts shapes (TipDoc for content_json, SeoResult for the full
// evaluator output) - no parallel writer model and no AI-produced score.

/** The canonical review artifact the W5 phase produces: the assembled
 *  Content Studio document, its rendered HTML and the full deterministic
 *  evaluator result. All types are the canonical @seo/contracts shapes. */
export interface WriterReview {
  /** Canonical Tiptap content document (the Content Studio content_json). */
  contentJson: TipDoc;
  /** Canonical render of the document via the existing renderer. */
  contentHtml: string;
  /** Full output of the existing Phase C evaluateSeo evaluator. */
  seo: SeoResult;
}

/** The single state definition for every writer graph. Reducers run on every
 *  write (including the initial invoke input), so channel construction already
 *  encodes the identity + lifecycle invariants; graph nodes cannot bypass
 *  them without failing the run.
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
  approval: Annotation<WriterApprovalStatus>({ reducer: replaceReducer, default: () => 'pending' }),
  approvalReason: Annotation<string | null>({ reducer: replaceReducer, default: () => null }),
  writtenSections: Annotation<WriterWrittenSection[]>({
    reducer: replaceReducer,
    default: () => [],
  }),
  writeNote: Annotation<string | null>({ reducer: replaceReducer, default: () => null }),
  review: Annotation<WriterReview | null>({ reducer: replaceReducer, default: () => null }),
  reviewStatus: Annotation<WriterReviewStatus>({ reducer: replaceReducer, default: () => 'pending' }),
  reviewNote: Annotation<string | null>({ reducer: replaceReducer, default: () => null }),
});

/** Full typed state a node receives. */
export type WriterState = typeof WriterStateAnnotation.State;
/** Partial typed state a node may return. */
export type WriterStateUpdate = typeof WriterStateAnnotation.Update;
