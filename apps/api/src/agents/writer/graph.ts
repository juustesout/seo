/**
 * Writer Agent graph (W0-W5).
 *
 * A linear LangGraph that walks the run lifecycle, gathers read-only,
 * project-scoped context for the writer's topic, turns it into a structural
 * article plan, pauses for explicit human approval and - only after an
 * explicit approval - writes the approved sections one AI call per section and
 * deterministically reviews the assembled article:
 *
 *   START -> initialize (idle -> running)
 *         -> gatherContext (fills bounded context; running -> planning)
 *         -> planOutline (planning -> awaiting_approval | failed)
 *         -> awaitApproval (interrupt)
 *              - reject -> rejected -> END
 *              - approve -> approved -> beginWriting (writing)
 *                          -> writeSections (reviewing | failed)
 *                          -> reviewContent (review_ready | failed)
 *                          -> awaitReviewSession (interrupt)
 *                                - accept -> completed -> END
 *                                - revise -> revising -> reviseSections
 *                                            (supersteps) -> reviewing
 *                                            -> reviewContent -> review_ready
 *                                            -> awaitReviewSession (rest)
 *
 * gatherContext is the only node that touches the outside world before
 * planning and it does so exclusively through the dependency-injected
 * read-only allowlist (WriterContextDependencies): no autonomous tools, no
 * direct Supabase, Qdrant, GSC or DataForSEO access, no AI calls, no writes,
 * no external HTTP from inside the graph. Every source degrades honestly - a
 * failing or unconfigured source never crashes the run, and retrieval output
 * is bounded and labelled untrusted by the boundary helpers before it is
 * stored.
 *
 * planOutline performs the single AI planning call through the injected
 * planner allowlist (WriterPlannerDependencies) and validates the reply at
 * the planner boundary. A proposed plan moves the run to awaiting_approval;
 * any honest failure (AI not configured, transport error, invalid output
 * after the corrective retry) ends the run failed with planStatus "failed"
 * and a bounded note - never a fabricated plan. planOutline has no tools and
 * performs no other side effects.
 *
 * awaitApproval is the W3 human gate. It calls LangGraph's interrupt(), so a
 * run with a proposed plan pauses right here instead of proceeding: no
 * writing, no publication, no scheduling, no further AI or provider work
 * happens automatically after the plan is proposed. The graph only continues
 * when the same thread is resumed through resumeWriterRun with a strictly
 * validated approve/reject decision (see approval.ts); the node itself
 * re-validates that resume value and degrades an out-of-band, invalid resume
 * to a failed run rather than trusting it. Rejection is terminal (rejected ->
 * END). Approval is the hard gate: nothing below ever runs without it.
 *
 * beginWriting + writeSections are the W4 controlled writing phase, reached
 * only from an approved run. beginWriting records the writing status; then
 * writeSections iterates the approved outline one section per superstep in
 * plan order (a self-loop) and calls the injected section writer allowlist
 * (WriterSectionDependencies) once per approved section (each call may
 * internally retry once on invalid output, mirroring planning). With a durable
 * checkpointer every completed section is persisted before the next one
 * starts, so a crash mid-writing resumes from the last persisted section
 * instead of rewriting it. The outline itself is code-owned and immutable: the
 * AI receives the fixed heading/key points/keywords and returns ONLY body
 * content, which the node re-validates and stores under the section's
 * deterministic plan index - no added/reordered sections, no model-chosen
 * structure, no AI routing. Any honest section failure (not_configured /
 * ai_error / invalid_output) ends the run failed, preserving whatever was
 * already written for debugging. There are no AI tools, no autonomous
 * research/publish decisions, and no AI-produced SEO score anywhere in the
 * workflow.
 *
 * reviewContent is the W5 deterministic review + assembly node, reached only
 * from a fully written run (status `reviewing`, set by writeSections when the
 * last section is persisted). It is a pure local conveyor (see review.ts): it
 * reassembles the written sections into one canonical Content Studio TipTap
 * document strictly in the approved plan order, renders content_html through
 * the existing canonical renderer and scores it with the existing Phase C SEO
 * evaluator - no AI call, no provider call, no database write, no job, no
 * publication, no new SEO rules. Success rests on `review_ready` with the
 * WriterReview artifact stored and a status the review session (W8) pauses on;
 * the writer has produced a canonical review artifact, not a saved article.
 * Any honest review failure (missing/extra section, invalid content,
 * render/evaluate error) ends the run failed. reviewContent never trusts
 * writtenSections order and never invents content.
 *
 * awaitReviewSession is the W8 review-session gate, the human interrupt a run
 * rests on after every review round. It pauses on `review_ready` (never
 * terminal) until the same thread is resumed with a strictly validated review
 * session decision (see revision.ts): `accept` moves the run to `completed`
 * (terminal - explicit save-finalization, the only way to complete a run;
 * nothing ever reaches completed automatically), while `revise` starts a
 * controlled revision round. The node re-validates the resume value, so an
 * out-of-band resume degrades to a failed run instead of being trusted.
 *
 * reviseSections is the W8 controlled revision phase, reached only from a
 * validated revise resume (status `revising`). Like writeSections it is split
 * into one superstep per requested section so that with a durable checkpointer
 * every rewritten section is persisted before the next AI call starts: each
 * invocation rewrites exactly the next not-yet-rewritten requested section
 * (derived from the persisted revisionProgress channel, which must always be an
 * exact ordered prefix of the validated request) and then routes back to itself
 * until every requested section has been rewritten. The approved plan stays
 * immutable, every unselected section is preserved byte-for-byte, and each
 * revision call goes through the injected revision writer allowlist
 * (WriterRevisionDependencies). When the requested sections are all rewritten
 * the round is recorded (revisionStatus completed, revisionCount/lastRevisionAt
 * bumped) and the run moves to `reviewing`, which flows straight into the
 * deterministic re-review (reviewContent) and back onto the review session with
 * a fresh review_ready artifact - the human always decides again after a
 * revision. An honest revision failure (unwired writer, provider error, invalid
 * output, a degraded resume, an unexpected throw) stops the run failed and
 * keeps the sections that were successfully rewritten for inspection.
 *
 * The compiled graph always carries a checkpointer (the run id doubles as the
 * thread id, see runtime.ts), so runs pause and resume on the exact same
 * checkpoint. createWriterGraph defaults to an in-memory MemorySaver for tests
 * and process-local use, and accepts an injected durable checkpointer (e.g. the
 * official PostgresSaver) so production runs survive process restarts. With a
 * durable checkpointer each writing/revision superstep below is persisted after
 * every section, which is what lets a crashed run resume mid-writing or
 * mid-revision without rewriting already-persisted sections.
 */

import { END, MemorySaver, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import { ApiError } from '../../apiErrors.js';
import { logger } from '../../logger.js';
import {
  boundWriterContext,
  contextNoteFromError,
  NO_ADAPTER_DEPENDENCIES,
  type WriterContextDependencies,
  type WriterContextInput,
  type WriterContentResult,
  type WriterIntelligenceResult,
  type WriterKnowledgeResult,
} from './context.js';
import {
  boundEvidence,
  degradedResearchResult,
  NO_RESEARCH_DEPENDENCIES,
  type WriterResearchDependencies,
  type WriterResearchRequest,
  type WriterResearchResult,
} from './evidence.js';
import {
  NO_PLANNER_DEPENDENCIES,
  type WriterPlanInput,
  type WriterPlannerDependencies,
  type WriterPlanOutcome,
} from './planner.js';
import { parseWriterApprovalDecision } from './approval.js';
import {
  buildMagicRevisionRequest,
  magicSessionToRequest,
  parseReviewSessionResume,
} from './magic.js';
import { validateRevisionSectionIds } from './revision.js';
import {
  DEFAULT_WRITER_REVIEW_DEPENDENCIES,
  reviewWriterContent,
  type WriterReviewDependencies,
  type WriterReviewInput,
} from './review.js';
import {
  NO_REVISION_WRITER_DEPENDENCIES,
  isValidRevisionContent,
  type WriterRevisionDependencies,
  type WriterRevisionInput,
} from './revisionWriter.js';
import {
  NO_SECTION_WRITER_DEPENDENCIES,
  isValidSectionContent,
  WRITER_SECTION_MAX_PREVIOUS_CHARS,
  type WriterSectionDependencies,
  type WriterSectionInput,
} from './sectionWriter.js';
import { WriterStateAnnotation, writerSectionIdFor, writerSectionIndexFor } from './state.js';
import type { WriterState, WriterStateUpdate, WriterWrittenSection } from './state.js';

export const WRITER_INITIALIZE_NODE = 'initialize';
export const WRITER_GATHER_NODE = 'gatherContext';
export const WRITER_PLAN_NODE = 'planOutline';
export const WRITER_APPROVAL_NODE = 'awaitApproval';
export const WRITER_BEGIN_WRITING_NODE = 'beginWriting';
export const WRITER_WRITE_SECTIONS_NODE = 'writeSections';
export const WRITER_REVIEW_NODE = 'reviewContent';
export const WRITER_REVIEW_SESSION_NODE = 'awaitReviewSession';
export const WRITER_REVISE_SECTIONS_NODE = 'reviseSections';
export const WRITER_GATHER_EVIDENCE_NODE = 'gatherEvidence';

/** Marks the run as started; later phases assemble per-project context here. */
function initializeNode(_state: WriterState): WriterStateUpdate {
  return { status: 'running' };
}

/** A provider that explicitly signals "not configured" keeps that honest
 *  status instead of being flattened into a generic "unavailable". */
function isNotConfiguredError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'not_configured';
}

function knowledgeFallback(err: unknown): WriterKnowledgeResult {
  return {
    status: isNotConfiguredError(err) ? 'not_configured' : 'unavailable',
    note: contextNoteFromError(err),
    chunks: [],
  };
}

function contentFallback(err: unknown): WriterContentResult {
  return {
    status: isNotConfiguredError(err) ? 'not_configured' : 'unavailable',
    note: contextNoteFromError(err),
    items: [],
  };
}

function intelligenceFallback(err: unknown): WriterIntelligenceResult {
  return {
    status: isNotConfiguredError(err) ? 'not_configured' : 'unavailable',
    note: contextNoteFromError(err),
    keywords: [],
  };
}

/**
 * Runs the three read-only context adapters for this project's brief, writes
 * the bounded, source-labelled result into state and advances the run into
 * the planning phase. Adapter failures degrade per-source and never fail the
 * run; only a run that gathers no usable plan (planOutline) can end failed.
 */
async function gatherContextNode(deps: WriterContextDependencies, state: WriterState): Promise<WriterStateUpdate> {
  const input: WriterContextInput = {
    projectId: state.projectId,
    topic: state.topic,
    targetKeyword: state.targetKeyword ?? null,
  };
  const [knowledge, content, intelligence] = await Promise.all([
    deps.getKnowledge(input).catch(knowledgeFallback),
    deps.getExistingContent(input).catch(contentFallback),
    deps.getIntelligence(input).catch(intelligenceFallback),
  ]);
  return { context: boundWriterContext({ knowledge, content, intelligence }), status: 'planning' };
}

/**
 * The W10.2 research node. It runs only from a review_ready rest after an
 * explicit `{ action: "research" }` session resume (evidenceRequest set) and
 * is a read-only gather exactly like gatherContext: it calls the injected
 * research allowlist (never SQL/providers directly), bounds + labels the raw
 * results through boundEvidence and stores them as durable evidence. A
 * throwing research call degrades to honest per-source results instead of
 * failing the run, and the run always returns to the review-session rest with
 * whatever evidence was honestly gathered - never a fabricated item.
 */
async function gatherEvidenceNode(
  deps: WriterResearchDependencies,
  state: WriterState,
): Promise<WriterStateUpdate> {
  const request = state.evidenceRequest;
  if (!request) {
    return { evidenceRequest: null };
  }
  const input: WriterResearchRequest = {
    projectId: state.projectId,
    topic: state.topic,
    targetKeyword: state.targetKeyword ?? null,
    purpose: request.purpose,
  };
  let result: WriterResearchResult;
  try {
    result = await deps.research(input);
  } catch (err) {
    logger.error({ err, projectId: state.projectId }, 'writer research threw unexpectedly');
    result = degradedResearchResult(request.purpose);
  }
  return { evidence: boundEvidence(new Date().toISOString(), result), evidenceRequest: null };
}

/** Maps a planner outcome onto the run state. A proposed plan rests on
 *  awaiting_approval with approval left "pending"; every other outcome ends
 *  the run failed with the honest bounded note and no plan - planStatus
 *  "failed" is never paired with a fabricated plan. */
function planOutcomeUpdate(outcome: WriterPlanOutcome): WriterStateUpdate {
  if (outcome.ok) {
    return {
      status: 'awaiting_approval',
      approval: 'pending',
      approvalReason: null,
      planStatus: 'proposed',
      plan: outcome.plan,
      planNote: null,
    };
  }
  return { status: 'failed', planStatus: 'failed', plan: null, planNote: contextNoteFromError(outcome.note) };
}

/**
 * Runs the single AI planning call for the gathered context. The planner is
 * the only AI access the graph has; a throwing planner (an unexpected bug) is
 * degraded to an honest failed outcome instead of crashing the run without a
 * terminal state.
 */
async function planOutlineNode(deps: WriterPlannerDependencies, state: WriterState): Promise<WriterStateUpdate> {
  const input: WriterPlanInput = {
    projectId: state.projectId,
    topic: state.topic,
    targetKeyword: state.targetKeyword ?? null,
    context: state.context,
  };
  try {
    return planOutcomeUpdate(await deps.plan(input));
  } catch (err) {
    logger.error({ err, projectId: state.projectId }, 'writer planner threw unexpectedly');
    return {
      status: 'failed',
      planStatus: 'failed',
      plan: null,
      planNote: contextNoteFromError(err),
    };
  }
}

/**
 * The human approval gate (W3). interrupt() pauses the run on its first pass
 * with a bounded, human-readable request (the resume value only exists once a
 * caller resumes this exact thread via resumeWriterRun). The resume value is
 * the strictly validated approval decision; the node re-validates it here so
 * even an out-of-band resume cannot steer the run - an invalid value degrades
 * the run to failed with a bounded note instead of being trusted. Nothing
 * after this line ever runs automatically: no writing, no publication, no AI
 * or provider call happens unless an explicit decision resumes the run.
 */
function awaitApprovalNode(
  state: WriterState,
  config?: { configurable?: { thread_id?: string } },
): WriterStateUpdate {
  const resumeValue: unknown = interrupt({
    request: 'Approve or reject the proposed article plan before any writing starts.',
    runId: config?.configurable?.thread_id ?? null,
    status: 'awaiting_approval',
    planTitle: state.plan?.title ?? null,
  });

  const parsed = parseWriterApprovalDecision(resumeValue);
  if (!parsed.ok) {
    return {
      status: 'failed',
      planNote: `The approval resume input was invalid: ${parsed.note}`,
    };
  }
  switch (parsed.decision.decision) {
    case 'approve':
      return { status: 'approved', approval: 'approved', approvalReason: null };
    case 'reject':
      return { status: 'rejected', approval: 'rejected', approvalReason: parsed.decision.reason ?? null };
  }
}

/** Bounded tail of the previous written section for continuity (at most one
 *  section, truncated): keeps coherence without a token snowball. */
function previousSectionContext(written: WriterWrittenSection[]): string | null {
  const last = written[written.length - 1];
  if (!last) return null;
  return last.content.slice(0, WRITER_SECTION_MAX_PREVIOUS_CHARS);
}

/** Marks the run as writing once approval has passed (approved -> writing). */
function beginWritingNode(): WriterStateUpdate {
  return { status: 'writing' };
}

/**
 * The W4 controlled writing phase (runs only after explicit approval). The
 * phase is split into one superstep per approved section so that with a
 * durable checkpointer every written section is persisted before the next AI
 * call starts: each invocation writes exactly the next not-yet-written section
 * (derived from the persisted writtenSections channel) and then routes back to
 * itself until the approved outline is complete. That self-loop is what makes
 * crash recovery idempotent - a restarted thread resumes from its last
 * checkpoint and picks up at the next section instead of rewriting the ones
 * already persisted. Each section is stored under its deterministic plan
 * index, so no section can be added, reordered or written twice; the approved
 * outline is never passed back to the model as mutable structure and no AI
 * output ever routes the graph. An honest failure (unwired writer, provider
 * error, invalid output, an unexpected throw) stops the run failed and keeps
 * whatever was already written for debugging.
 */
async function writeSectionsNode(
  deps: WriterSectionDependencies,
  state: WriterState,
): Promise<WriterStateUpdate> {
  const plan = state.plan;
  if (!plan) {
    return { status: 'failed', writeNote: 'No approved plan to write.' };
  }
  const written = state.writtenSections;
  const index = written.length;
  // Idempotency guard: the persisted progress marker must always be an exact,
  // ordered prefix of the approved outline. Anything else means the checkpoint
  // cannot be trusted and the run fails closed instead of re-writing.
  for (let i = 0; i < index; i += 1) {
    if (written[i].sectionId !== writerSectionIdFor(i)) {
      return {
        status: 'failed',
        writtenSections: written,
        writeNote: 'Persisted written sections are out of order; aborting to prevent duplicates.',
      };
    }
  }
  if (index >= plan.sections.length) {
    return { status: 'reviewing', writtenSections: written, writeNote: null };
  }

  const sectionId = writerSectionIdFor(index);
  const section = plan.sections[index];
  const input: WriterSectionInput = {
    projectId: state.projectId,
    topic: state.topic,
    targetKeyword: state.targetKeyword ?? null,
    articleTitle: plan.title,
    sectionIndex: index,
    section,
    context: state.context,
    previousSectionContent: previousSectionContext(written),
  };
  let outcome: Awaited<ReturnType<WriterSectionDependencies['writeSection']>>;
  try {
    outcome = await deps.writeSection(input);
  } catch (err) {
    logger.error({ err, projectId: state.projectId }, 'writer section writer threw unexpectedly');
    return { status: 'failed', writtenSections: written, writeNote: contextNoteFromError(err) };
  }
  if (!outcome.ok) {
    return { status: 'failed', writtenSections: written, writeNote: outcome.note };
  }
  if (!isValidSectionContent(outcome.content)) {
    return {
      status: 'failed',
      writtenSections: written,
      writeNote: `Section ${sectionId} produced invalid content and was not stored.`,
    };
  }
  if (written.some((entry) => entry.sectionId === sectionId)) {
    return {
      status: 'failed',
      writtenSections: written,
      writeNote: `Section ${sectionId} was already written; aborting to prevent duplicates.`,
    };
  }
  const next = [...written, { sectionId, content: outcome.content }];
  return next.length >= plan.sections.length
    ? { status: 'reviewing', writtenSections: next, writeNote: null }
    : { status: 'writing', writtenSections: next, writeNote: null };
}

/**
 * The W5 deterministic review and content-assembly node. It runs only after a
 * fully written run (status `reviewing`, set by writeSections/reviseSections
 * when no further section writes are due) and is a pure local pipeline over the
 * immutable approved plan and the written sections: it never talks to AI,
 * providers, the database or the scheduler. The conditional edge guarantees the
 * node only ever sees a reviewing run; the defensive guard still fails honestly
 * instead of trusting an inconsistent state. On success the run rests on
 * `review_ready` with the canonical artifact stored - the review session (W8)
 * interrupt is the next node and decides what happens to it.
 */
function reviewContentNode(
  deps: WriterReviewDependencies,
  state: WriterState,
): WriterStateUpdate {
  if (state.status !== 'reviewing') {
    return { status: 'failed', reviewStatus: 'failed', reviewNote: 'Review ran outside the reviewing phase.' };
  }
  const plan = state.plan;
  if (!plan) {
    return { status: 'failed', reviewStatus: 'failed', reviewNote: 'No approved plan to review.' };
  }
  const input: WriterReviewInput = {
    plan,
    writtenSections: state.writtenSections,
    targetKeyword: state.targetKeyword ?? null,
  };
  const outcome = reviewWriterContent(deps, input);
  if (!outcome.ok) {
    return { status: 'failed', reviewStatus: 'failed', reviewNote: outcome.note };
  }
  return { status: 'review_ready', review: outcome.review, reviewStatus: 'completed', reviewNote: null };
}

/**
 * The W8 human review-session gate. A run with a canonical review_ready
 * artifact pauses here via interrupt() instead of ending: `review_ready` is the
 * resting, revisable state, and nothing (no accept, no further AI work, no
 * publication) happens automatically. The graph only continues when the same
 * thread is resumed through a strictly validated review-session resume (see
 * revision.ts + magic.ts); the node itself re-validates that resume value and
 * degrades an out-of-band, invalid resume to a failed run rather than trusting
 * it. An accept is the explicit save-finalization to `completed` (terminal,
 * never automatic); a revise stores the validated, plan-ordered revision
 * request and moves to `revising`; a W10.1 magic resume translates through
 * buildMagicRevisionRequest into the exact same revising round (same status,
 * request metadata only - no new lifecycle state, no auto-acceptance).
 */
function awaitReviewSessionNode(
  state: WriterState,
  config?: { configurable?: { thread_id?: string } },
): WriterStateUpdate {
  if (state.status !== 'review_ready') {
    return { status: 'failed', reviewStatus: 'failed', reviewNote: 'The review session ran outside the review_ready state.' };
  }
  const plan = state.plan;
  if (!plan) {
    return { status: 'failed', reviewStatus: 'failed', reviewNote: 'No approved plan to accept or revise.' };
  }
  const resumeValue: unknown = interrupt({
    request: 'Accept the review-ready article or revise specific sections before it is saved.',
    runId: config?.configurable?.thread_id ?? null,
    status: 'review_ready',
    planTitle: plan.title,
    review: {
      seoScore: state.review?.seo.score ?? null,
      sectionCount: plan.sections.length,
      writtenSections: state.writtenSections.length,
      revisionCount: state.revisionCount ?? 0,
    },
  });

  const parsed = parseReviewSessionResume(resumeValue);
  if (!parsed.ok) {
    return {
      status: 'failed',
      reviewStatus: 'failed',
      reviewNote: `The review session resume input was invalid: ${parsed.note}`,
    };
  }
  const resume = parsed.resume;
  if (resume.action === 'accept') {
    return { status: 'completed' };
  }
  if (resume.action === 'research') {
    // W10.2 explicit research gather. The run stays on review_ready (no new
    // lifecycle state): the transient evidenceRequest marker routes the graph
    // to the read-only gather node, which stores bounded evidence and returns
    // to this same review-session rest. Nothing is written or published.
    return { evidenceRequest: { purpose: resume.purpose ?? 'revision' } };
  }
  if (resume.action === 'magic') {
    const built = buildMagicRevisionRequest(plan, magicSessionToRequest(resume));
    if (!built.ok) {
      return {
        status: 'failed',
        revisionStatus: 'failed',
        revisionNote: `The magic request was invalid: ${built.note}`,
      };
    }
    return {
      status: 'revising',
      revisionStatus: 'revising',
      revisionRequest: built.request,
      revisionNote: null,
      revisionProgress: [],
    };
  }
  const validated = validateRevisionSectionIds(plan, resume.sectionIds);
  if (!validated.ok) {
    return {
      status: 'failed',
      revisionStatus: 'failed',
      revisionNote: `The revision request was invalid: ${validated.note}`,
    };
  }
  return {
    status: 'revising',
    revisionStatus: 'revising',
    revisionRequest: {
      sectionIds: validated.sectionIds,
      instruction: resume.instruction,
    },
    revisionNote: null,
    revisionProgress: [],
  };
}

/** Bounded tail of the written section at plan position index-1 (already in its
 *  final post-revision state because revisions run in plan order), used only
 *  for continuity while rewriting a requested section. */
function previousSectionContextAt(written: WriterWrittenSection[], index: number): string | null {
  if (index <= 0) return null;
  const previous = written.find((entry) => entry.sectionId === writerSectionIdFor(index - 1));
  if (!previous) return null;
  return previous.content.slice(0, WRITER_SECTION_MAX_PREVIOUS_CHARS);
}

/**
 * The W8 controlled revision phase (runs only after a validated revise resume,
 * status `revising`). Mirrors writeSections: one superstep per requested
 * section so that with a durable checkpointer every rewritten section is
 * persisted before the next AI call starts. Each invocation rewrites exactly
 * the next requested section that revisionProgress does not yet cover (the
 * progress channel must always be an exact, ordered prefix of the validated
 * request - anything else fails closed instead of re-writing or skipping) and
 * routes back to itself until the round is complete. Each rewrite replaces only
 * the stored body of that one approved-plan section; unselected sections and
 * the approved plan itself are never touched. When every requested section has
 * been rewritten the round is recorded (revisionStatus completed,
 * revisionCount/lastRevisionAt bumped) and the run moves to `reviewing`, which
 * flows straight into the deterministic re-review and back onto the review
 * session. An honest failure (unwired writer, provider error, invalid output, a
 * degraded resume, an unexpected throw) stops the run failed and keeps whatever
 * sections were successfully rewritten for inspection.
 */
async function reviseSectionsNode(
  deps: WriterRevisionDependencies,
  state: WriterState,
): Promise<WriterStateUpdate> {
  if (state.status !== 'revising') {
    return { status: 'failed', revisionStatus: 'failed', revisionNote: 'Revision ran outside the revising phase.' };
  }
  const plan = state.plan;
  const request = state.revisionRequest;
  if (!plan) {
    return { status: 'failed', revisionStatus: 'failed', revisionNote: 'No approved plan to revise.' };
  }
  if (!request) {
    return { status: 'failed', revisionStatus: 'failed', revisionNote: 'No revision request to apply.' };
  }
  const validated = validateRevisionSectionIds(plan, request.sectionIds);
  if (!validated.ok) {
    return {
      status: 'failed',
      revisionStatus: 'failed',
      revisionNote: `The revision request was invalid: ${validated.note}`,
    };
  }
  const requested = validated.sectionIds;
  const progress = state.revisionProgress ?? [];
  // Idempotency guard: the persisted progress marker must always be an exact,
  // ordered prefix of the validated request. Anything else means the checkpoint
  // cannot be trusted and the run fails closed instead of re-writing.
  for (let i = 0; i < progress.length; i += 1) {
    if (progress[i] !== requested[i]) {
      return {
        status: 'failed',
        revisionStatus: 'failed',
        revisionNote: 'Persisted revision progress is out of order; aborting to prevent duplicates.',
      };
    }
  }
  if (progress.length >= requested.length) {
    // Round fully applied: record it and flow into the deterministic re-review
    // (reviewing -> reviewContent), never looping again.
    return {
      status: 'reviewing',
      revisionStatus: 'completed',
      revisionNote: null,
      revisionCount: (state.revisionCount ?? 0) + 1,
      lastRevisionAt: new Date().toISOString(),
    };
  }

  const sectionId = requested[progress.length];
  const index = writerSectionIndexFor(sectionId);
  if (!Number.isInteger(index) || index < 0 || index >= plan.sections.length) {
    return {
      status: 'failed',
      revisionStatus: 'failed',
      revisionNote: `Section ${sectionId} is not part of the approved plan; aborting the revision.`,
    };
  }
  const existing = state.writtenSections.find((entry) => entry.sectionId === sectionId);
  if (!existing) {
    return {
      status: 'failed',
      revisionStatus: 'failed',
      revisionNote: `Section ${sectionId} has no written content to revise; aborting the revision.`,
    };
  }
  const section = plan.sections[index];
  const input: WriterRevisionInput = {
    projectId: state.projectId,
    topic: state.topic,
    targetKeyword: state.targetKeyword ?? null,
    articleTitle: plan.title,
    sectionIndex: index,
    section,
    instruction: request.instruction,
    currentContent: existing.content,
    context: state.context,
    evidence: state.evidence ?? null,
    ...(request.magic !== undefined ? { magic: request.magic } : {}),
  };
  let outcome: Awaited<ReturnType<WriterRevisionDependencies['reviseSection']>>;
  try {
    outcome = await deps.reviseSection(input);
  } catch (err) {
    logger.error({ err, projectId: state.projectId }, 'writer revision writer threw unexpectedly');
    return {
      status: 'failed',
      revisionStatus: 'failed',
      revisionNote: contextNoteFromError(err),
    };
  }
  if (!outcome.ok) {
    return { status: 'failed', revisionStatus: 'failed', revisionNote: outcome.note };
  }
  if (!isValidRevisionContent(outcome.content)) {
    return {
      status: 'failed',
      revisionStatus: 'failed',
      revisionNote: `Section ${sectionId} produced invalid revised content and was not stored.`,
    };
  }
  const updated = state.writtenSections.map((entry) =>
    entry.sectionId === sectionId ? { sectionId, content: outcome.content } : entry,
  );
  return { status: 'revising', writtenSections: updated, revisionProgress: [...progress, sectionId] };
}

/**
 * Builds a fresh compiled writer graph. Options.context injects the read-only
 *  adapter allowlist, options.planner the AI planning allowlist,
 *  options.sectionWriter the section-writing allowlist, options.revisionWriter
 *  the revision-writing allowlist and options.review the deterministic review
 *  allowlist; without the former four every source reports not configured,
 *  planning reports "no AI planner wired", an approved run's writing reports
 *  "no section writer wired" and a revise resume reports "no revision writer
 *  wired", ending the run failed instead of fabricating a plan, a section or a
 *  revision. The review allowlist defaults to the canonical @seo/contracts
 *  evaluator and renderer, so a successful write or revision always flows
 *  through the deterministic W5 review.
 *
 * The compiled graph always carries a checkpointer, which the interrupt pause
 * requires. options.checkpointer injects a durable one (production); the
 * default is an in-memory MemorySaver for tests and process-local use. With a
 * durable checkpointer the per-section writing/revision supersteps are
 * persisted after every section, so a crashed run can resume mid-writing or
 * mid-revision without re-writing persisted sections. Every invoke must carry
 * { configurable: { thread_id: <runId> } }. */
export function createWriterGraph(options: {
  context?: WriterContextDependencies;
  planner?: WriterPlannerDependencies;
  sectionWriter?: WriterSectionDependencies;
  revisionWriter?: WriterRevisionDependencies;
  research?: WriterResearchDependencies;
  review?: WriterReviewDependencies;
  checkpointer?: BaseCheckpointSaver;
} = {}) {
  const contextDeps = options.context ?? NO_ADAPTER_DEPENDENCIES;
  const plannerDeps = options.planner ?? NO_PLANNER_DEPENDENCIES;
  const sectionWriterDeps = options.sectionWriter ?? NO_SECTION_WRITER_DEPENDENCIES;
  const revisionWriterDeps = options.revisionWriter ?? NO_REVISION_WRITER_DEPENDENCIES;
  const researchDeps = options.research ?? NO_RESEARCH_DEPENDENCIES;
  const reviewDeps = options.review ?? DEFAULT_WRITER_REVIEW_DEPENDENCIES;
  return new StateGraph(WriterStateAnnotation)
    .addNode(WRITER_INITIALIZE_NODE, initializeNode)
    .addNode(WRITER_GATHER_NODE, (state: WriterState) => gatherContextNode(contextDeps, state))
    .addNode(WRITER_PLAN_NODE, (state: WriterState) => planOutlineNode(plannerDeps, state))
    .addNode(WRITER_APPROVAL_NODE, (state: WriterState, config) => awaitApprovalNode(state, config))
    .addNode(WRITER_BEGIN_WRITING_NODE, beginWritingNode)
    .addNode(WRITER_WRITE_SECTIONS_NODE, (state: WriterState) => writeSectionsNode(sectionWriterDeps, state))
    .addNode(WRITER_REVIEW_NODE, (state: WriterState) => reviewContentNode(reviewDeps, state))
    .addNode(WRITER_REVIEW_SESSION_NODE, (state: WriterState, config) => awaitReviewSessionNode(state, config))
    .addNode(WRITER_REVISE_SECTIONS_NODE, (state: WriterState) => reviseSectionsNode(revisionWriterDeps, state))
    .addNode(WRITER_GATHER_EVIDENCE_NODE, (state: WriterState) => gatherEvidenceNode(researchDeps, state))
    .addEdge(START, WRITER_INITIALIZE_NODE)
    .addEdge(WRITER_INITIALIZE_NODE, WRITER_GATHER_NODE)
    .addEdge(WRITER_GATHER_NODE, WRITER_PLAN_NODE)
    .addEdge(WRITER_PLAN_NODE, WRITER_APPROVAL_NODE)
    .addConditionalEdges(WRITER_APPROVAL_NODE, (state: WriterState) =>
      state.status === 'approved' ? WRITER_BEGIN_WRITING_NODE : END,
    )
    .addEdge(WRITER_BEGIN_WRITING_NODE, WRITER_WRITE_SECTIONS_NODE)
    .addConditionalEdges(WRITER_WRITE_SECTIONS_NODE, (state: WriterState) =>
      state.status === 'writing'
        ? WRITER_WRITE_SECTIONS_NODE
        : state.status === 'reviewing'
          ? WRITER_REVIEW_NODE
          : END,
    )
    .addConditionalEdges(WRITER_REVIEW_NODE, (state: WriterState) =>
      state.status === 'review_ready' ? WRITER_REVIEW_SESSION_NODE : END,
    )
    .addConditionalEdges(WRITER_REVIEW_SESSION_NODE, (state: WriterState) =>
      state.status === 'revising'
        ? WRITER_REVISE_SECTIONS_NODE
        : state.evidenceRequest
          ? WRITER_GATHER_EVIDENCE_NODE
          : END,
    )
    .addConditionalEdges(WRITER_GATHER_EVIDENCE_NODE, (state: WriterState) =>
      state.status === 'review_ready' && state.evidenceRequest === null
        ? WRITER_REVIEW_SESSION_NODE
        : END,
    )
    .addConditionalEdges(WRITER_REVISE_SECTIONS_NODE, (state: WriterState) =>
      state.status === 'revising'
        ? WRITER_REVISE_SECTIONS_NODE
        : state.status === 'reviewing'
          ? WRITER_REVIEW_NODE
          : END,
    )
    .compile({ checkpointer: options.checkpointer ?? new MemorySaver() });
}

/** The compiled writer graph: owns the run's MemorySaver checkpointer. */
export type CompiledWriterGraph = ReturnType<typeof createWriterGraph>;
