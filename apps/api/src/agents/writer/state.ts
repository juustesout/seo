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
 * reviewStatus "completed".
 *
 * W8 turns the post-review state into a controlled revision loop. A fully
 * written run moves writing -> reviewing -> review_ready and then pauses on the
 * review session interrupt instead of ending: `review_ready` is the resting,
 * revisable state that exposes the canonical artifact. From there an explicit
 * human decision resumes the same thread:
 *
 *   - accept -> `completed` (terminal, explicit save-finalization; only reachable
 *     through this accept, never automatically) - END;
 *   - revise -> `revising`: the AI rewrites exactly the requested, plan-validated
 *     sections (one call per section, in plan order, supersteps persisted after
 *     every section) while every unselected section and the approved plan stay
 *     untouched, then reviewing -> review_ready runs the deterministic re-review
 *     and the run rests again on `review_ready` with the fresh artifact.
 *
 * `review_ready` is therefore NOT terminal and `completed` is never reached by a
 * successful review alone: a run can be revised any number of times and only
 * ends through accept (or an honest failed/rejected exit). The revision request
 * only ever arrives through the validated review-session resume input (see
 * revision.ts) - never from AI, context or a prompt - and revisionNote carries
 * the bounded, honest failure note of a revision round. Any honest review
 * failure (missing/extra section, invalid content, render/evaluate error) or
 * revision failure (not_configured / ai_error / invalid_output / a degraded
 * resume) ends the run failed with a bounded note. A failed run keeps whatever
 * plan and written sections it honestly produced.
 */

import { Annotation } from '@langchain/langgraph';
import type { SeoResult, TipDoc } from '@seo/contracts';
import { emptyWriterContext, type WriterContext } from './context.js';
import type { WriterEvidence, WriterResearchPurpose } from './evidence.js';
import type { WriterIntelligence, WriterIntelligencePurpose } from './intelligence.js';
import type { WriterMagicIntent } from './magic.js';

/** All statuses a writer run can ever be in; empty transition lists mean the
 *  run rests there (rejected / failed are terminal; completed is terminal and
 *  reached only through the explicit review-session accept). awaiting_approval
 *  pauses on the human approval interrupt and is left only through an explicit
 *  approve/reject resume. review_ready is the W8 resting, revisable state after
 *  the deterministic review: it pauses on the review-session interrupt and is
 *  left through an explicit accept (-> completed) or revise (-> revising)
 *  resume. revising is the async W8 rewriting phase; reviewing is the
 *  (near-instant, deterministic) re-review that follows it and flows on to
 *  review_ready in the same execution - it is lifecycle vocabulary, not an
 *  observable rest. */
export const WRITER_STATUSES = [
  'idle',
  'running',
  'planning',
  'awaiting_approval',
  'approved',
  'writing',
  'reviewing',
  'revising',
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

/** Where the deterministic review stands. pending until a review round runs;
 *  completed only after it produced a canonical review artifact; failed on any
 *  honest review failure. Independent of the run lifecycle status. */
export const WRITER_REVIEW_STATUSES = ['pending', 'completed', 'failed'] as const;
export type WriterReviewStatus = (typeof WRITER_REVIEW_STATUSES)[number];

/** Legal one-step transitions between writer statuses; empty means the run
 *  rests there (rejected / failed are terminal; completed is terminal and only
 *  reachable through the explicit review-session accept - a successful review
 *  alone never completes a run). approved -> writing -> reviewing ->
 *  review_ready is the code-owned W4+W5 path that starts only after an explicit
 *  approval: writing fills the approved sections and the deterministic review
 *  phase assembles the canonical document; review_ready -> revising ->
 *  reviewing -> review_ready is the W8 revision loop that starts only after an
 *  explicit, validated revise resume, and review_ready -> completed is the
 *  explicit accept. awaiting_approval -> failed exists so a run whose resume
 *  input cannot be validated degrades honestly instead of hanging;
 *  writing/reviewing/revising/review_ready -> failed let an honest section,
 *  revision or review failure stop the run. */
export const STATUS_TRANSITIONS: Record<WriterStatus, readonly WriterStatus[]> = {
  idle: ['running'],
  running: ['planning'],
  planning: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['approved', 'rejected', 'failed'],
  approved: ['writing'],
  writing: ['reviewing', 'failed'],
  reviewing: ['review_ready', 'failed'],
  revising: ['reviewing', 'failed'],
  review_ready: ['revising', 'completed', 'failed'],
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

/** Zero-based approved-plan index a deterministic section id addresses; NaN
 *  when the id is not `section_<number>`. */
export function writerSectionIndexFor(sectionId: string): number {
  const match = /^section_(\d+)$/.exec(sectionId);
  return match ? Number(match[1]) : Number.NaN;
}

/** One section of article body content, keyed to exactly one approved plan
 *  section (by deterministic section id). */
export interface WriterWrittenSection {
  sectionId: string;
  content: string;
}

// --- revision artifact (W8) ---------------------------------------------------
//
// The W8 review session turns the resting review_ready run into a controlled
// revision loop. Each explicit revise resume carries a validated request that
// addresses exactly the sections to rewrite (stable `section_<index>` ids that
// the backend re-validates against the canonical approved plan) plus the human
// instruction. The request is the only thing that ever selects sections: never
// UI order, heading text or an AI identifier. revisionCount / lastRevisionAt
// record how many rounds this run has gone through; revisionNote carries the
// bounded, honest note of a failed round.

/** The validated, plan-ordered set of sections a revision round rewrites. */
export interface WriterRevisionRequest {
  /** Stable section ids to rewrite, ascending in approved-plan order, every id
   *  validated to exist in the approved plan and present at most once. */
  sectionIds: string[];
  /** Human revision instruction (authoritative, bounded). */
  instruction: string;
  /** W10.1 Section Magic intent metadata when this round is a magic
   *  transformation rather than a plain W8 revision. Optional so a plain
   *  revise round stays identical to W8; the durable request keeps it so a
   *  crash mid-round can re-issue the exact magic after a restart. */
  magic?: WriterMagicIntent;
}

/** Whether a revision round is currently pending/active on the run. */
export const WRITER_REVISION_STATUSES = ['none', 'revising', 'completed', 'failed'] as const;
export type WriterRevisionStatus = (typeof WRITER_REVISION_STATUSES)[number];

// --- research & evidence artifact (W10.2) --------------------------------------
//
// The W10.2 research surface lets the human explicitly gather bounded,
// project-scoped evidence for the review_ready draft. The evidence channel
// holds the durable, sanitized result (bounds/labels applied in evidence.ts
// before it is written) and is offered to later revision/magic rounds as
// untrusted material only; the evidenceRequest channel is a transient
// routing marker set by the review session on a research resume and cleared by
// the gather node when evidence is stored - it never rests.

/** Transient marker that routes a research resume to the gather node. */
export interface WriterEvidenceRequest {
  /** Why the human gathered evidence (vocabulary only; never steers work). */
  purpose: WriterResearchPurpose;
}

// --- intelligence artifact (W10.3) --------------------------------------------
//
// The W10.3 intelligence surface lets the human explicitly combine the project's
// existing sources into a bounded, deduplicated set of findings for the
// review_ready draft. The intelligence channel holds the durable, sanitized
// result (bounds/labels applied in intelligence.ts before it is written) and is
// offered to later revision/magic rounds as untrusted context only; the
// intelligenceRequest channel is a transient routing marker set by the review
// session on an intelligence resume and cleared by the gather node when the
// snapshot is stored - it never rests.

/** Transient marker that routes an intelligence resume to the gather node. */
export interface WriterIntelligenceIntent {
  /** Why the human gathered intelligence (vocabulary only; never steers work). */
  purpose: WriterIntelligencePurpose;
  /** Optional bounded focus for the gather. */
  focus: string | null;
  /** Validated, plan-scoped section ids the gather is focused on (empty = all). */
  sections: string[];
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
  revisionStatus: Annotation<WriterRevisionStatus>({ reducer: replaceReducer, default: () => 'none' }),
  revisionRequest: Annotation<WriterRevisionRequest | null>({ reducer: replaceReducer, default: () => null }),
  revisionNote: Annotation<string | null>({ reducer: replaceReducer, default: () => null }),
  /** Progress of the current revision round: which requested section ids have
   *  been rewritten so far (idempotency guard, persisted with each superstep). */
  revisionProgress: Annotation<string[]>({ reducer: replaceReducer, default: () => [] }),
  /** Number of revision rounds this run has applied. */
  revisionCount: Annotation<number>({ reducer: replaceReducer, default: () => 0 }),
  /** ISO timestamp of the most recent applied revision round, if any. */
  lastRevisionAt: Annotation<string | null>({ reducer: replaceReducer, default: () => null }),
  /** Durable W10.2 research context gathered for this run, or null until the
   *  human triggers a research operation. Bounded + labelled in evidence.ts. */
  evidence: Annotation<WriterEvidence | null>({ reducer: replaceReducer, default: () => null }),
  /** Transient W10.2 routing marker set by a research session resume and
   *  cleared by the gather node; never observed at rest. */
  evidenceRequest: Annotation<WriterEvidenceRequest | null>({ reducer: replaceReducer, default: () => null }),
  /** Durable W10.3 intelligence snapshot gathered for this run, or null until
   *  the human triggers an intelligence operation. Bounded + labelled in
   *  intelligence.ts. */
  intelligence: Annotation<WriterIntelligence | null>({ reducer: replaceReducer, default: () => null }),
  /** Transient W10.3 routing marker set by an intelligence session resume and
   *  cleared by the gather node; never observed at rest. */
  intelligenceRequest: Annotation<WriterIntelligenceIntent | null>({
    reducer: replaceReducer,
    default: () => null,
  }),
});

/** Full typed state a node receives. */
export type WriterState = typeof WriterStateAnnotation.State;
/** Partial typed state a node may return. */
export type WriterStateUpdate = typeof WriterStateAnnotation.Update;
