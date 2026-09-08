/**
 * Writer Agent graph (W0-W3).
 *
 * A linear LangGraph that walks the run lifecycle, gathers read-only,
 * project-scoped context for the writer's topic, turns it into a structural
 * article plan and pauses for explicit human approval before anything could
 * be written:
 *
 *   START -> initialize (idle -> running)
 *         -> gatherContext (fills bounded context; running -> planning)
 *         -> planOutline (planning -> awaiting_approval | failed)
 *         -> awaitApproval (interrupt) -> resume: approved | rejected -> END
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
 * to a failed run rather than trusting it. Approve ends approved, reject ends
 * rejected - both terminal, neither invents a dummy writing node.
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
import { WriterStateAnnotation } from './state.js';
import type { WriterState, WriterStateUpdate } from './state.js';

export const WRITER_INITIALIZE_NODE = 'initialize';
export const WRITER_GATHER_NODE = 'gatherContext';
export const WRITER_PLAN_NODE = 'planOutline';
export const WRITER_APPROVAL_NODE = 'awaitApproval';

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

/** Builds a fresh compiled writer graph. Options.context injects the read-only
 *  adapter allowlist and options.planner the AI planning allowlist; without
 *  them every source reports not configured and planning reports "no AI
 *  planner wired", ending the run failed instead of fabricating a plan.
 *
 * The compiled graph owns a MemorySaver checkpointer, which the interrupt
 * pause requires. It is in-memory and process-local: a restart loses every
 * paused run (resume then fails honestly with writer_run_not_found); W8
 * swaps the saver for durable storage here without changing the workflow.
 * Every invoke must carry { configurable: { thread_id: <runId> } }. */
export function createWriterGraph(options: {
  context?: WriterContextDependencies;
  planner?: WriterPlannerDependencies;
} = {}) {
  const contextDeps = options.context ?? NO_ADAPTER_DEPENDENCIES;
  const plannerDeps = options.planner ?? NO_PLANNER_DEPENDENCIES;
  return new StateGraph(WriterStateAnnotation)
    .addNode(WRITER_INITIALIZE_NODE, initializeNode)
    .addNode(WRITER_GATHER_NODE, (state: WriterState) => gatherContextNode(contextDeps, state))
    .addNode(WRITER_PLAN_NODE, (state: WriterState) => planOutlineNode(plannerDeps, state))
    .addNode(WRITER_APPROVAL_NODE, (state: WriterState, config) => awaitApprovalNode(state, config))
    .addEdge(START, WRITER_INITIALIZE_NODE)
    .addEdge(WRITER_INITIALIZE_NODE, WRITER_GATHER_NODE)
    .addEdge(WRITER_GATHER_NODE, WRITER_PLAN_NODE)
    .addEdge(WRITER_PLAN_NODE, WRITER_APPROVAL_NODE)
    .addEdge(WRITER_APPROVAL_NODE, END)
    .compile({ checkpointer: new MemorySaver() });
}

/** The compiled writer graph: owns the run's MemorySaver checkpointer. */
export type CompiledWriterGraph = ReturnType<typeof createWriterGraph>;
