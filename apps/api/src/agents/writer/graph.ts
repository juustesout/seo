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
 *                          -> writeSections (review_ready | failed)
 *                          -> reviewContent (completed | failed) -> END
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
 * only from an approved run. beginWriting records the writing status; then a
 * single writeSections node iterates the approved outline in plan order and
 * calls the injected section writer allowlist (WriterSectionDependencies)
 * once per approved section (each call may internally retry once on invalid
 * output, mirroring planning). The outline itself is code-owned and
 * immutable: the AI receives the fixed heading/key points/keywords and returns
 * ONLY body content, which the node re-validates and stores under the section's
 * deterministic plan index - no added/reordered sections, no model-chosen
 * structure, no AI routing. Any honest section failure (not_configured /
 * ai_error / invalid_output) ends the run failed, preserving whatever was
 * already written for debugging. There are no AI tools, no autonomous
 * research/publish decisions, and no AI-produced SEO score anywhere in the
 * workflow.
 *
 * reviewContent is the W5 deterministic review + assembly phase, reached only
 * from a fully written run (review_ready). It is a pure local conveyor (see
 * review.ts): it reassembles the written sections into one canonical Content
 * Studio TipTap document strictly in the approved plan order, renders
 * content_html through the existing canonical renderer and scores it with the
 * existing Phase C SEO evaluator - no AI call, no provider call, no database
 * write, no job, no publication, no new SEO rules. Success rests on
 * `completed` with the WriterReview artifact stored; the writer has produced a
 * canonical review artifact, not a saved article. Any honest review failure
 * (missing/extra section, invalid content, render/evaluate error) ends the run
 * failed. reviewContent never trusts writtenSections order and never invents
 * content.
 *
 * The compiled graph owns a MemorySaver checkpointer (the run id doubles as
 * the thread id, see runtime.ts), so runs pause and resume on the exact same
 * checkpoint. MemorySaver is in-memory: a process restart loses every paused
 * run, and resume then fails honestly with writer_run_not_found. W8 replaces
 * it with durable storage behind the same runId/resume surface.
 */

import { END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
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
  NO_PLANNER_DEPENDENCIES,
  type WriterPlanInput,
  type WriterPlannerDependencies,
  type WriterPlanOutcome,
} from './planner.js';
import { parseWriterApprovalDecision } from './approval.js';
import {
  DEFAULT_WRITER_REVIEW_DEPENDENCIES,
  reviewWriterContent,
  type WriterReviewDependencies,
  type WriterReviewInput,
} from './review.js';
import {
  NO_SECTION_WRITER_DEPENDENCIES,
  isValidSectionContent,
  WRITER_SECTION_MAX_PREVIOUS_CHARS,
  type WriterSectionDependencies,
  type WriterSectionInput,
} from './sectionWriter.js';
import { WriterStateAnnotation, writerSectionIdFor } from './state.js';
import type { WriterState, WriterStateUpdate, WriterWrittenSection } from './state.js';

export const WRITER_INITIALIZE_NODE = 'initialize';
export const WRITER_GATHER_NODE = 'gatherContext';
export const WRITER_PLAN_NODE = 'planOutline';
export const WRITER_APPROVAL_NODE = 'awaitApproval';
export const WRITER_BEGIN_WRITING_NODE = 'beginWriting';
export const WRITER_WRITE_SECTIONS_NODE = 'writeSections';
export const WRITER_REVIEW_NODE = 'reviewContent';

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
 * The W4 controlled writing loop (runs only after explicit approval). It
 * iterates the approved outline strictly in plan order and calls the injected
 * section writer once per approved section; each section is stored under its
 * deterministic plan index, so no section can be added, reordered or written
 * twice. The approved outline is never passed back to the model as
 * mutable structure and no AI output ever routes the graph. An honest failure
 * (unwired writer, provider error, invalid output, an unexpected throw)
 * stops the run failed and keeps whatever was already written for debugging.
 */
async function writeSectionsNode(
  deps: WriterSectionDependencies,
  state: WriterState,
): Promise<WriterStateUpdate> {
  const plan = state.plan;
  if (!plan) {
    return { status: 'failed', writeNote: 'No approved plan to write.' };
  }
  const written: WriterWrittenSection[] = [];
  try {
    for (let index = 0; index < plan.sections.length; index += 1) {
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
      const outcome = await deps.writeSection(input);
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
      written.push({ sectionId, content: outcome.content });
    }
  } catch (err) {
    logger.error({ err, projectId: state.projectId }, 'writer section writer threw unexpectedly');
    return { status: 'failed', writtenSections: written, writeNote: contextNoteFromError(err) };
  }
  return { status: 'review_ready', writtenSections: written, writeNote: null };
}

/**
 * The W5 deterministic review and content-assembly node. It runs only after a
 * fully written run (review_ready) and is a pure local pipeline over the
 * immutable approved plan and the written sections: it never talks to AI,
 * providers, the database or the scheduler. The conditional edge guarantees
 * the node only ever sees a review_ready run; the defensive guard still fails
 * honestly instead of trusting an inconsistent state.
 */
function reviewContentNode(
  deps: WriterReviewDependencies,
  state: WriterState,
): WriterStateUpdate {
  if (state.status !== 'review_ready') {
    return { status: 'failed', reviewStatus: 'failed', reviewNote: 'Review ran outside the writing phase.' };
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
  return { status: 'completed', review: outcome.review, reviewStatus: 'completed', reviewNote: null };
}

/** Builds a fresh compiled writer graph. Options.context injects the read-only
 *  adapter allowlist, options.planner the AI planning allowlist,
 *  options.sectionWriter the section-writing allowlist and options.review the
 *  deterministic review allowlist; without the former three every source
 *  reports not configured, planning reports "no AI planner wired" and an
 *  approved run's writing reports "no section writer wired", ending the run
 *  failed instead of fabricating a plan or a section. The review allowlist
 *  defaults to the canonical @seo/contracts evaluator and renderer, so a
 *  successful write always flows through the deterministic W5 review.
 *
 * The compiled graph owns a MemorySaver checkpointer, which the interrupt
 * pause requires. It is in-memory and process-local: a restart loses every
 * paused run (resume then fails honestly with writer_run_not_found); W8
 * swaps the saver for durable storage here without changing the workflow.
 * Every invoke must carry { configurable: { thread_id: <runId> } }. */
export function createWriterGraph(options: {
  context?: WriterContextDependencies;
  planner?: WriterPlannerDependencies;
  sectionWriter?: WriterSectionDependencies;
  review?: WriterReviewDependencies;
} = {}) {
  const contextDeps = options.context ?? NO_ADAPTER_DEPENDENCIES;
  const plannerDeps = options.planner ?? NO_PLANNER_DEPENDENCIES;
  const sectionWriterDeps = options.sectionWriter ?? NO_SECTION_WRITER_DEPENDENCIES;
  const reviewDeps = options.review ?? DEFAULT_WRITER_REVIEW_DEPENDENCIES;
  return new StateGraph(WriterStateAnnotation)
    .addNode(WRITER_INITIALIZE_NODE, initializeNode)
    .addNode(WRITER_GATHER_NODE, (state: WriterState) => gatherContextNode(contextDeps, state))
    .addNode(WRITER_PLAN_NODE, (state: WriterState) => planOutlineNode(plannerDeps, state))
    .addNode(WRITER_APPROVAL_NODE, (state: WriterState, config) => awaitApprovalNode(state, config))
    .addNode(WRITER_BEGIN_WRITING_NODE, beginWritingNode)
    .addNode(WRITER_WRITE_SECTIONS_NODE, (state: WriterState) => writeSectionsNode(sectionWriterDeps, state))
    .addNode(WRITER_REVIEW_NODE, (state: WriterState) => reviewContentNode(reviewDeps, state))
    .addEdge(START, WRITER_INITIALIZE_NODE)
    .addEdge(WRITER_INITIALIZE_NODE, WRITER_GATHER_NODE)
    .addEdge(WRITER_GATHER_NODE, WRITER_PLAN_NODE)
    .addEdge(WRITER_PLAN_NODE, WRITER_APPROVAL_NODE)
    .addConditionalEdges(WRITER_APPROVAL_NODE, (state: WriterState) =>
      state.status === 'approved' ? WRITER_BEGIN_WRITING_NODE : END,
    )
    .addEdge(WRITER_BEGIN_WRITING_NODE, WRITER_WRITE_SECTIONS_NODE)
    .addConditionalEdges(WRITER_WRITE_SECTIONS_NODE, (state: WriterState) =>
      state.status === 'review_ready' ? WRITER_REVIEW_NODE : END,
    )
    .addEdge(WRITER_REVIEW_NODE, END)
    .compile({ checkpointer: new MemorySaver() });
}

/** The compiled writer graph: owns the run's MemorySaver checkpointer. */
export type CompiledWriterGraph = ReturnType<typeof createWriterGraph>;
