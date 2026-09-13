import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeProvider, KnowledgeSearchResult } from '@seo/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  KNOWLEDGE_RETRIEVAL_FUSED_CANDIDATES,
  KNOWLEDGE_RETRIEVAL_RRF_K,
  KNOWLEDGE_RETRIEVAL_VECTOR_CANDIDATES,
} from './limits.js';
import { candidateKey, managedSourceIdFromPayload, sourceExternalId } from './identity.js';
import { resolveRetrievalMode } from './mode.js';
import { fuseCandidates } from './fusion.js';
import { vectorHitToCandidate } from './vector.js';
import { retrieveCandidates } from './pipeline.js';
import type { KnowledgeCandidate, RetrievalRequest } from './types.js';

function candidate(
  sourceId: string,
  chunkId: string | null,
  origin: 'vector' | 'lexical',
  score: number,
  content = `content ${sourceId}`,
): KnowledgeCandidate {
  return {
    key: candidateKey(sourceId, chunkId),
    sourceId,
    chunkId,
    origin,
    content,
    score,
    payload: { source_id: sourceExternalId(sourceId), text: content, chunk_index: chunkId },
  };
}

function request(overrides: Partial<RetrievalRequest> = {}): RetrievalRequest {
  return { projectId: 'p1', query: 'q', limit: 10, mode: 'hybrid', ...overrides };
}

function fakeSb(rpc: ReturnType<typeof vi.fn>): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

function fakeProvider(search: ReturnType<typeof vi.fn>): KnowledgeProvider {
  return { id: 'qdrant', search } as unknown as KnowledgeProvider;
}

describe('retrieval identity + mode (KB10)', () => {
  it('derives a canonical key from source + chunk, never content', () => {
    expect(candidateKey('s1', 0)).toBe('s1::0');
    expect(candidateKey('s1', null)).toBe('s1::');
    expect(candidateKey('s1', '0')).toBe(candidateKey('s1', 0));
    expect(candidateKey('s2', 0)).not.toBe(candidateKey('s1', 0));
  });

  it('resolves the explicit retrieval mode with hybrid as the default', () => {
    expect(resolveRetrievalMode({})).toBe('hybrid');
    expect(resolveRetrievalMode({ KNOWLEDGE_RETRIEVAL_MODE: 'hybrid' })).toBe('hybrid');
    expect(resolveRetrievalMode({ KNOWLEDGE_RETRIEVAL_MODE: 'vector' })).toBe('vector');
    expect(resolveRetrievalMode({ KNOWLEDGE_RETRIEVAL_MODE: '  VECTOR ' })).toBe('vector');
    expect(resolveRetrievalMode({ KNOWLEDGE_RETRIEVAL_MODE: 'bogus' })).toBe('hybrid');
  });
});

describe('fusion (KB10)', () => {
  it('ranks overlapping candidates by reciprocal rank and dedups by identity', () => {
    const a = candidate('a', '0', 'vector', 0.9, 'vector a');
    const b = candidate('b', '0', 'vector', 0.8, 'vector b');
    const bLex = candidate('b', '0', 'lexical', 3.5, 'lexical b');
    const c = candidate('c', '0', 'lexical', 3.0);

    const { candidates, fused } = fuseCandidates([a, b], [bLex, c]);

    expect(fused).toBe(true);
    expect(candidates.map((x) => x.key)).toEqual(['b::0', 'a::0', 'c::0']);
    // Overlap sums both ranks; a vector+lexical match outranks either alone.
    const score = (rank: number) => 1 / (KNOWLEDGE_RETRIEVAL_RRF_K + rank);
    expect(candidates[0]!.score).toBeCloseTo(score(2) + score(1), 12);
    expect(candidates[1]!.score).toBeCloseTo(score(1), 12);
    expect(candidates[2]!.score).toBeCloseTo(score(2), 12);
    // Identity wins over content: the provider's canonical payload is kept.
    expect(candidates[0]!.content).toBe('vector b');
  });

  it('is deterministic for equal fused scores (stable key tie-break)', () => {
    const x = candidate('x', '0', 'vector', 1);
    const y = candidate('y', '0', 'vector', 1);
    const xLex = candidate('x', '0', 'lexical', 1);
    const yLex = candidate('y', '0', 'lexical', 1);

    const forward = fuseCandidates([x, y], [yLex, xLex]).candidates.map((c) => c.key);
    const reverse = fuseCandidates([y, x], [xLex, yLex]).candidates.map((c) => c.key);
    expect(forward).toEqual(['x::0', 'y::0']);
    expect(reverse).toEqual(forward);
  });

  it('returns a single origin untouched (original score, order, no RRF)', () => {
    const vectorOnly = fuseCandidates([candidate('a', '0', 'vector', 0.9)], []);
    expect(vectorOnly.fused).toBe(false);
    expect(vectorOnly.candidates[0]!.score).toBe(0.9);
    expect(vectorOnly.candidates[0]!.origin).toBe('vector');

    const lexicalOnly = fuseCandidates([], [candidate('a', '0', 'lexical', 4.2)]);
    expect(lexicalOnly.fused).toBe(false);
    expect(lexicalOnly.candidates[0]!.score).toBe(4.2);
    expect(lexicalOnly.candidates[0]!.origin).toBe('lexical');
  });

  it('caps the fused list at the central budget', () => {
    const vector = Array.from({ length: 60 }, (_, i) => candidate(`v${i}`, null, 'vector', 60 - i));
    const lexical = Array.from({ length: 60 }, (_, i) => candidate(`l${i}`, null, 'lexical', 60 - i));
    const { candidates } = fuseCandidates(vector, lexical);
    expect(candidates).toHaveLength(KNOWLEDGE_RETRIEVAL_FUSED_CANDIDATES);
  });
});

describe('vector adapter (KB10)', () => {
  it('maps a managed hit to a chunk-identified candidate and drops empty content', () => {
    const hit: KnowledgeSearchResult = {
      id: 'point-1',
      score: 0.87,
      payload: {
        source_id: sourceExternalId('00000000-0000-0000-0000-0000000000aa'),
        text: 'chunk body',
        chunk_index: 2,
      },
    };
    const mapped = vectorHitToCandidate(hit);
    expect(mapped).toMatchObject({
      key: '00000000-0000-0000-0000-0000000000aa::2',
      sourceId: '00000000-0000-0000-0000-0000000000aa',
      chunkId: '2',
      origin: 'vector',
      content: 'chunk body',
      score: 0.87,
    });
    expect(vectorHitToCandidate({ id: 'p', score: 1, payload: { text: '   ' } })).toBeNull();
    expect(managedSourceIdFromPayload(hit.payload)).toBe('00000000-0000-0000-0000-0000000000aa');
  });
});

describe('hybrid pipeline degradation (KB10)', () => {
  it('degrades to lexical candidates when the vector provider fails', async () => {
    const search = vi.fn(async () => {
      throw new Error('Qdrant down');
    });
    const rpc = vi.fn(async () => ({
      data: [{ source_id: '00000000-0000-0000-0000-0000000000aa', chunk_index: 0, score: 1.5, content: 'lex' }],
      error: null,
    }));

    const outcome = await retrieveCandidates(
      { provider: fakeProvider(search), sb: fakeSb(rpc) },
      request(),
    );

    expect(outcome.diagnostics.vectorFailed).toBe(true);
    expect(outcome.diagnostics.lexicalFailed).toBe(false);
    expect(outcome.candidates.map((c) => c.origin)).toEqual(['lexical']);
  });

  it('degrades to vector candidates when the lexical RPC fails', async () => {
    const search = vi.fn(async () => [
      { id: 'p', score: 0.5, payload: { source_id: 'page:https://a.example', title: 'A', text: 'vec' } },
    ]);
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'relation missing' } }));

    const outcome = await retrieveCandidates(
      { provider: fakeProvider(search), sb: fakeSb(rpc) },
      request(),
    );

    expect(outcome.diagnostics.vectorFailed).toBe(false);
    expect(outcome.diagnostics.lexicalFailed).toBe(true);
    expect(outcome.candidates.map((c) => c.origin)).toEqual(['vector']);
    expect(outcome.candidates[0]!.score).toBe(0.5);
  });

  it('fails closed only when both origins fail', async () => {
    const search = vi.fn(async () => {
      throw new Error('Qdrant down');
    });
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'rpc down' } }));

    await expect(
      retrieveCandidates({ provider: fakeProvider(search), sb: fakeSb(rpc) }, request()),
    ).rejects.toThrow('Qdrant down');
  });

  it('vector mode never calls lexical and propagates vector errors', async () => {
    const search = vi.fn(async () => {
      throw new Error('Qdrant down');
    });
    const rpc = vi.fn();

    await expect(
      retrieveCandidates({ provider: fakeProvider(search), sb: fakeSb(rpc) }, request({ mode: 'vector' })),
    ).rejects.toThrow('Qdrant down');
    expect(rpc).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  });

  it('hybrid mode requests the bounded vector candidate window', async () => {
    const search = vi.fn(async () => []);
    const rpc = vi.fn(async () => ({ data: [], error: null }));

    await retrieveCandidates({ provider: fakeProvider(search), sb: fakeSb(rpc) }, request({ limit: 5 }));

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: KNOWLEDGE_RETRIEVAL_VECTOR_CANDIDATES }));
  });
});
