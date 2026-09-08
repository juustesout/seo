/**
 * Writer Agent W0 tests: the graph compiles and runs a valid request through
 * the full lifecycle, identity fields survive the run unchanged, invalid
 * input is rejected at the boundary, and the state reducers refuse illegal
 * transitions and identity rewrites even when a node attempts them.
 */

import { describe, expect, it } from 'vitest';
import { StateGraph, START, END } from '@langchain/langgraph';
import { ApiError } from '../../apiErrors.js';
import {
  WRITER_STATUSES,
  assertStatusTransition,
  WriterStateAnnotation,
  createWriterRunId,
  createWriterGraph,
  isWriterRunId,
  parseWriterRunRequest,
  runWriterOnce,
  type WriterRunRequest,
} from './index.js';

const projectId = 'c00162dd-d23e-4904-85ca-76cccc6d8c90';
const requestId = 'req-123';

describe('writer graph lifecycle', () => {
  it('compiles and completes a valid run preserving identity', async () => {
    const graph = createWriterGraph();
    const finalState = await graph.invoke({ projectId, requestId, status: 'idle' });

    expect(finalState.projectId).toBe(projectId);
    expect(finalState.requestId).toBe(requestId);
    expect(finalState.status).toBe('completed');
  });

  it('runWriterOnce returns a terminal completed run with a fresh wr_ run id', async () => {
    const result = await runWriterOnce({ projectId, requestId });

    expect(result.projectId).toBe(projectId);
    expect(result.requestId).toBe(requestId);
    expect(result.status).toBe('completed');
    expect(isWriterRunId(result.runId)).toBe(true);
  });

  it('runWriterOnce keeps an explicitly supplied run id', async () => {
    const runId = createWriterRunId();
    const result = await runWriterOnce({ runId, projectId, requestId });

    expect(result.runId).toBe(runId);
  });

  it('refuses to start a run at a terminal or skipped status', async () => {
    const graph = createWriterGraph();

    await expect(graph.invoke({ projectId, requestId, status: 'completed' })).rejects.toThrow(
      'Invalid writer status transition',
    );
  });
});

describe('writer graph deny-by-default invariants', () => {
  it('allows only listed one-step status transitions', () => {
    expect(() => assertStatusTransition('idle', 'running')).not.toThrow();
    expect(() => assertStatusTransition('running', 'completed')).not.toThrow();
    expect(() => assertStatusTransition('running', 'failed')).not.toThrow();
    expect(() => assertStatusTransition('running', 'cancelled')).not.toThrow();

    expect(() => assertStatusTransition('idle', 'completed')).toThrow('Invalid writer status transition');
    expect(() => assertStatusTransition('completed', 'running')).toThrow('Invalid writer status transition');
    expect(() => assertStatusTransition('idle', 'unknown' as never)).toThrow('Invalid writer status transition');
  });

  it('rejects a node that rewrites the immutable project identity', async () => {
    const graph = new StateGraph(WriterStateAnnotation)
      .addNode('bad', () => ({ projectId: '11111111-2222-3333-4444-555555555555' }))
      .addEdge(START, 'bad')
      .addEdge('bad', END)
      .compile();

    await expect(graph.invoke({ projectId, requestId, status: 'idle' })).rejects.toThrow(
      'Immutable writer state field changed',
    );
  });

  it('declares the full intended status vocabulary', () => {
    expect(WRITER_STATUSES).toEqual(['idle', 'running', 'completed', 'failed', 'cancelled']);
  });
});

describe('writer run input validation', () => {
  it('rejects a malformed projectId', () => {
    expect(() => parseWriterRunRequest({ projectId: 'not-a-uuid', requestId })).toThrow(ApiError);
    expect(() => parseWriterRunRequest({ projectId: '', requestId })).toThrow(ApiError);
  });

  it('rejects an empty or oversized requestId', () => {
    expect(() => parseWriterRunRequest({ projectId, requestId: '' })).toThrow(ApiError);
    expect(() => parseWriterRunRequest({ projectId, requestId: '   ' })).toThrow(ApiError);
    expect(() => parseWriterRunRequest({ projectId, requestId: 'x'.repeat(201) })).toThrow(ApiError);
  });

  it('rejects a malformed explicit runId', () => {
    const noSuffix = { runId: 'wr_', projectId, requestId } as unknown as WriterRunRequest;
    const notPrefixed = { runId: 'not-a-run-id', projectId, requestId } as unknown as WriterRunRequest;
    expect(() => parseWriterRunRequest(noSuffix)).toThrow(ApiError);
    expect(() => parseWriterRunRequest(notPrefixed)).toThrow(ApiError);
  });

  it('normalises valid identifiers to an idle start state', () => {
    expect(parseWriterRunRequest({ projectId, requestId })).toEqual({
      projectId,
      requestId,
      status: 'idle',
    });
  });
});
