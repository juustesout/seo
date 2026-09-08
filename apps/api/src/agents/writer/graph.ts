/**
 * Writer Agent graph (W0 + W1).
 *
 * A linear LangGraph that walks the run lifecycle and gathers read-only,
 * project-scoped context for the writer's topic:
 *
 *   START -> initialize (idle -> running)
 *         -> gatherContext (fills bounded context from injected adapters)
 *         -> finalize (running -> completed) -> END
 *
 * gatherContext is the only node that touches the outside world and it does
 * so exclusively through the dependency-injected read-only allowlist
 * (WriterContextDependencies): no autonomous tools, no direct Supabase,
 * Qdrant, GSC or DataForSEO access, no AI calls, no writes, no external HTTP
 * from inside the graph. Every source degrades honestly - a failing or
 * unconfigured source never crashes the run, and retrieval output is bounded
 * and labelled untrusted by the boundary helpers before it is stored.
 *
 * The checkpointer seam lives in compile() below: when checkpointing or
 * interrupts arrive (W3+), a durable saver is swapped in here and the node
 * and edge structure of the workflow does not change. The writer run id
 * (see index.ts) maps to the LangGraph thread id once a checkpointer exists.
 */

import { END, START, StateGraph } from '@langchain/langgraph';
import { ApiError } from '../../apiErrors.js';
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
import { WriterStateAnnotation } from './state.js';
import type { WriterState, WriterStateUpdate } from './state.js';

export const WRITER_INITIALIZE_NODE = 'initialize';
export const WRITER_GATHER_NODE = 'gatherContext';
export const WRITER_FINALIZE_NODE = 'finalize';

/** Marks the run as started; later phases assemble per-project context here. */
function initializeNode(_state: WriterState): WriterStateUpdate {
  return { status: 'running' };
}

/**
 * Marks the run as completed. In W0/W1 this is a pure status flip; later
 * phases branch here between more writer stages, a failed run or a cancelled
 * run.
 */
function finalizeNode(_state: WriterState): WriterStateUpdate {
  return { status: 'completed' };
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
 * Runs the three read-only context adapters for this project's brief and
 * writes the bounded, source-labelled result into state. Adapter failures
 * degrade per-source and never fail the run.
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
  return { context: boundWriterContext({ knowledge, content, intelligence }) };
}

/** Builds a fresh compiled writer graph. Options.context injects the read-only
 *  adapter allowlist; without it every source reports not configured. */
export function createWriterGraph(options: { context?: WriterContextDependencies } = {}) {
  const deps = options.context ?? NO_ADAPTER_DEPENDENCIES;
  return new StateGraph(WriterStateAnnotation)
    .addNode(WRITER_INITIALIZE_NODE, initializeNode)
    .addNode(WRITER_GATHER_NODE, (state: WriterState) => gatherContextNode(deps, state))
    .addNode(WRITER_FINALIZE_NODE, finalizeNode)
    .addEdge(START, WRITER_INITIALIZE_NODE)
    .addEdge(WRITER_INITIALIZE_NODE, WRITER_GATHER_NODE)
    .addEdge(WRITER_GATHER_NODE, WRITER_FINALIZE_NODE)
    .addEdge(WRITER_FINALIZE_NODE, END)
    .compile();
}
