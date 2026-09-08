/**
 * Writer Agent graph (W0-W2).
 *
 * A linear LangGraph that walks the run lifecycle, gathers read-only,
 * project-scoped context for the writer's topic and turns it into a
 * structural article plan:
 *
 *   START -> initialize (idle -> running)
 *         -> gatherContext (fills bounded context; running -> planning)
 *         -> planOutline (planning -> awaiting_approval | failed) -> END
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
 * the planner boundary. A proposed plan rests the run on awaiting_approval;
 * any honest failure (AI not configured, transport error, invalid output
 * after the corrective retry) ends the run failed with planStatus "failed"
 * and a bounded note - never a fabricated plan. planOutline has no tools and
 * performs no other side effects.
 *
 * The checkpointer seam lives in compile() below: when checkpointing or
 * interrupts arrive (W3+), a durable saver is swapped in here and the node
 * and edge structure of the workflow does not change. The writer run id
 * (see index.ts) maps to the LangGraph thread id once a checkpointer exists.
 */

import { END, START, StateGraph } from '@langchain/langgraph';
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
import { WriterStateAnnotation } from './state.js';
import type { WriterState, WriterStateUpdate } from './state.js';

export const WRITER_INITIALIZE_NODE = 'initialize';
export const WRITER_GATHER_NODE = 'gatherContext';
export const WRITER_PLAN_NODE = 'planOutline';

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
 *  awaiting_approval; every other outcome ends the run failed with the honest
 *  bounded note and no plan - planStatus "failed" is never paired with a
 *  fabricated plan. */
function planOutcomeUpdate(outcome: WriterPlanOutcome): WriterStateUpdate {
  if (outcome.ok) {
    return { status: 'awaiting_approval', planStatus: 'proposed', plan: outcome.plan, planNote: null };
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

/** Builds a fresh compiled writer graph. Options.context injects the read-only
 *  adapter allowlist and options.planner the AI planning allowlist; without
 *  them every source reports not configured and planning reports "no AI
 *  planner wired", ending the run failed instead of fabricating a plan. */
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
    .addEdge(START, WRITER_INITIALIZE_NODE)
    .addEdge(WRITER_INITIALIZE_NODE, WRITER_GATHER_NODE)
    .addEdge(WRITER_GATHER_NODE, WRITER_PLAN_NODE)
    .addEdge(WRITER_PLAN_NODE, END)
    .compile();
}
