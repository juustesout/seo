/**
 * Writer Agent graph (W0 foundation).
 *
 * A linear LangGraph that for now only walks the run lifecycle end to end:
 *
 *   START -> initialize (idle -> running) -> finalize (running -> completed) -> END
 *
 * It deliberately performs no tool calls, no writes, no provider work and no
 * AI calls. The graph ships with zero capabilities so every later capability
 * has to be granted explicitly (deny by default). Nodes are the only writers
 * of state, keeping the whole run inspectable and checkpointable as one unit;
 * there is no code path that reaches outside the graph in this phase.
 *
 * The checkpointer seam lives in compile() below: when checkpointing or
 * interrupts arrive (W3+), a durable saver is swapped in here and the node
 * and edge structure of the workflow does not change. The writer run id
 * (see index.ts) maps to the LangGraph thread id once a checkpointer exists.
 */

import { END, START, StateGraph } from '@langchain/langgraph';
import { WriterStateAnnotation } from './state.js';
import type { WriterState, WriterStateUpdate } from './state.js';

export const WRITER_INITIALIZE_NODE = 'initialize';
export const WRITER_FINALIZE_NODE = 'finalize';

/** Marks the run as started; W1+ assembles per-project context here. */
function initializeNode(_state: WriterState): WriterStateUpdate {
  return { status: 'running' };
}

/**
 * Marks the run as completed. In W0 this is a pure status flip; later phases
 * branch here between more writer stages, a failed run or a cancelled run.
 */
function finalizeNode(_state: WriterState): WriterStateUpdate {
  return { status: 'completed' };
}

/** Builds a fresh compiled writer graph with no checkpointer (W0). */
export function createWriterGraph() {
  return new StateGraph(WriterStateAnnotation)
    .addNode(WRITER_INITIALIZE_NODE, initializeNode)
    .addNode(WRITER_FINALIZE_NODE, finalizeNode)
    .addEdge(START, WRITER_INITIALIZE_NODE)
    .addEdge(WRITER_INITIALIZE_NODE, WRITER_FINALIZE_NODE)
    .addEdge(WRITER_FINALIZE_NODE, END)
    .compile();
}
