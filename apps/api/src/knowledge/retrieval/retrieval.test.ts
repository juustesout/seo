import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeProvider, KnowledgeSearchResult } from '@seo/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  KNOWLEDGE_RETRIEVAL_FUSED_CANDIDATES,
  KNOWLEDGE_RETRIEVAL_LEXICAL_CANDIDATES,
  KNOWLEDGE_RETRIEVAL_MAX_SCOPE_SOURCES,
  KNOWLEDGE_RETRIEVAL_RRF_K,
  KNOWLEDGE_RETRIEVAL_VECTOR_CANDIDATES,
} from './limits.js';
import { candidateKey, managedSourceIdFromPayload, sourceExternalId } from './identity.js';
import { normalizeKnowledgeQuery } from './normalize.js';
import { resolveRetrievalMode } from './mode.js';
import { fuseCandidates } from './fusion.js';
import { vectorHitToCandidate } from './vector.js';
import { retrieveCandidates } from './pipeline.js';
import { buildKnowledgeQueryPlan, type KnowledgeQueryPlan, type QueryPlanInput } from './plan.js';
import {
  RetrievalScopeError,
  buildRetrievalScope,
  scopeAllowsSystemKnowledge,
  toLexicalParams,
  toProviderSearchFilter,
} from './scope.js';
import { filterCandidatesToScope, managedIdsFromCandidates } from './reconcile.js';
import type { KnowledgeRerankRequest, KnowledgeReranker } from './rerank.js';
import type { ManagedSourceFacts } from './sourceFacts.js';
import type { KnowledgeCandidate } from './types.js';

const SOURCE_A = '00000000-0000-0000-0000-0000000000aa';
const SOURCE_B = '00000000-0000-0000-0000-0000000000bb';
const COLLECTION = '00000000-0000-0000-0000-0000000000cc';

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

function systemCandidate(sourceId: string, origin: 'vector' | 'lexical', score: number, content = 'system'): KnowledgeCandidate {
  return {
    key: candidateKey(sourceId, null),
    sourceId,
    chunkId: null,
    origin,
    content,
    score,
    payload: { source_id: sourceId, title: 'System', text: content },
  };
}

function facts(id: string, overrides: Partial<ManagedSourceFacts> = {}): ManagedSourceFacts {
  return {
    id,
    name: `Source ${id.slice(-2)}`,
    sourceType: 'text',
    url: null,
    status: 'ready',
    collectionId: null,
    collectionName: null,
    ...overrides,
  };
}

function fakeSb(rpc: ReturnType<typeof vi.fn>): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

function fakeProvider(search: ReturnType<typeof vi.fn>): KnowledgeProvider {
  return { id: 'qdrant', search } as unknown as KnowledgeProvider;
}

/** Thenable Supabase fake for the derived-scope (freshness) resolver. */
function scopeSb(rows: Array<Record<string, unknown>>, error: { message: string } | null = null): SupabaseClient {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    select: chain,
    eq: chain,
    in: chain,
    is: chain,
    order: chain,
    limit: chain,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: error ? null : rows, error }).then(resolve),
  });
  return { from: () => builder } as unknown as SupabaseClient;
}

async function planFor(
  input: Partial<QueryPlanInput> & { mode?: QueryPlanInput['mode'] } = {},
  sb: SupabaseClient = {} as SupabaseClient,
): Promise<KnowledgeQueryPlan> {
  return buildKnowledgeQueryPlan(sb, { projectId: 'p1', query: 'q', limit: 10, mode: 'hybrid', ...input });
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

  it('has a single canonical query normalizer', () => {
    expect(normalizeKnowledgeQuery(undefined)).toBe('');
    expect(normalizeKnowledgeQuery('  a\t b\n')).toBe('a b');
    expect(normalizeKnowledgeQuery('   ')).toBe('');
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
    const score = (rank: number) => 1 / (KNOWLEDGE_RETRIEVAL_RRF_K + rank);
    expect(candidates[0]!.score).toBeCloseTo(score(2) + score(1), 12);
    expect(candidates[1]!.score).toBeCloseTo(score(1), 12);
    expect(candidates[2]!.score).toBeCloseTo(score(2), 12);
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

    const lexicalOnly = fuseCandidates([], [candidate('a', '0', 'lexical', 4.2)]);
    expect(lexicalOnly.fused).toBe(false);
    expect(lexicalOnly.candidates[0]!.score).toBe(4.2);
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
      payload: { source_id: sourceExternalId(SOURCE_A), text: 'chunk body', chunk_index: 2 },
    };
    const mapped = vectorHitToCandidate(hit);
    expect(mapped).toMatchObject({
      key: `${SOURCE_A}::2`,
      sourceId: SOURCE_A,
      chunkId: '2',
      origin: 'vector',
      content: 'chunk body',
      score: 0.87,
    });
    expect(vectorHitToCandidate({ id: 'p', score: 1, payload: { text: '   ' } })).toBeNull();
    expect(managedSourceIdFromPayload(hit.payload)).toBe(SOURCE_A);
  });
});

// ---------------------------------------------------------------------------
// KB10.2 - query planning, canonical scope, filter projection and reconciliation
// ---------------------------------------------------------------------------

describe('query plan (KB10.2)', () => {
  it('is built from normalized input and deep-frozen', async () => {
    const plan = await planFor({ query: 'canonical', limit: 5, mode: 'hybrid' });
    expect(plan).toMatchObject({ projectId: 'p1', query: 'canonical', limit: 5, mode: 'hybrid' });
    expect(plan.retrieval).toEqual({ vector: true, lexical: true });
    expect(plan.budgets).toEqual({
      vector: KNOWLEDGE_RETRIEVAL_VECTOR_CANDIDATES,
      lexical: KNOWLEDGE_RETRIEVAL_LEXICAL_CANDIDATES,
      fused: KNOWLEDGE_RETRIEVAL_FUSED_CANDIDATES,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.retrieval)).toBe(true);
    expect(Object.isFrozen(plan.budgets)).toBe(true);
    expect(Object.isFrozen(plan.scope)).toBe(true);
  });

  it('activates only the vector origin in vector mode', async () => {
    const plan = await planFor({ mode: 'vector' });
    expect(plan.retrieval).toEqual({ vector: true, lexical: false });
  });

  it('preserves explicit filters and never widens them', async () => {
    const plan = await planFor({
      filter: { sourceTypes: ['url', 'url', 'file'], sourceIds: [SOURCE_A], collectionId: COLLECTION },
    });
    expect(plan.scope.sourceTypes).toEqual(['url', 'file']);
    expect(plan.scope.requestedSourceIds).toEqual([SOURCE_A]);
    expect(plan.scope.collectionId).toBe(COLLECTION);
    expect(plan.scope.managedOnly).toBe(true);
    expect(plan.scope.empty).toBe(false);
  });

  it('fails safely on malformed or contradictory filters', async () => {
    await expect(planFor({ filter: { sourceIds: ['not-a-uuid'] } })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(planFor({ filter: { collectionId: 'nope' } })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(planFor({ filter: { freshness: ['bogus'] } })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      planFor({ filter: { collectionId: COLLECTION, uncategorized: true } }),
    ).rejects.toBeInstanceOf(RetrievalScopeError);
  });
});

describe('canonical scope + filter projection (KB10.2)', () => {
  it('projects one canonical scope onto both origin languages identically', async () => {
    const scope = await buildRetrievalScope({} as SupabaseClient, 'p1', {
      sourceTypes: ['url'],
      sourceIds: [SOURCE_A],
      collectionId: COLLECTION,
    });

    expect(toProviderSearchFilter(scope)).toEqual({
      collectionId: COLLECTION,
      sourceTypes: ['url'],
      sourceIds: [sourceExternalId(SOURCE_A)],
    });
    expect(toLexicalParams(scope)).toEqual({
      sourceIds: [SOURCE_A],
      sourceTypes: ['url'],
      collectionId: COLLECTION,
      uncategorized: false,
    });
  });

  it('marks a managed-only scope and reflects uncategorized', async () => {
    const scope = await buildRetrievalScope({} as SupabaseClient, 'p1', { uncategorized: true });
    expect(scope.managedOnly).toBe(true);
    expect(scopeAllowsSystemKnowledge(scope)).toBe(false);
    expect(toProviderSearchFilter(scope)).toEqual({ uncategorized: true });
    expect(toLexicalParams(scope)).toMatchObject({ uncategorized: true, sourceIds: null });
  });

  it('leaves an unrestricted scope open to system knowledge', async () => {
    const scope = await buildRetrievalScope({} as SupabaseClient, 'p1', {});
    expect(scope.managedOnly).toBe(false);
    expect(scopeAllowsSystemKnowledge(scope)).toBe(true);
    expect(toProviderSearchFilter(scope)).toBeUndefined();
  });

  it('resolves a freshness filter through the single freshness owner, bounded', async () => {
    const now = Date.now();
    const sb = scopeSb([
      {
        id: SOURCE_A,
        source_type: 'url',
        status: 'ready',
        collection_id: null,
        refresh_policy: 'daily',
        last_fetched_at: new Date(now - 1000).toISOString(),
        last_changed_at: null,
        next_refresh_at: new Date(now + 86_400_000).toISOString(),
        refresh_failures: 0,
      },
      {
        id: SOURCE_B,
        source_type: 'text',
        status: 'ready',
        collection_id: null,
        refresh_policy: null,
        last_fetched_at: null,
        last_changed_at: null,
        next_refresh_at: null,
        refresh_failures: 0,
      },
    ]);

    const fresh = await buildRetrievalScope(sb, 'p1', { freshness: ['fresh'] });
    expect(fresh.effectiveSourceIds).toEqual([SOURCE_A]);
    expect(fresh.freshness).toEqual(['fresh']);

    const unknown = await buildRetrievalScope(sb, 'p1', { freshness: ['unknown'] });
    expect(unknown.effectiveSourceIds).toEqual([SOURCE_B]);
  });

  it('fails closed when a derived scope is too broad to bound', async () => {
    const rows = Array.from({ length: KNOWLEDGE_RETRIEVAL_MAX_SCOPE_SOURCES + 1 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      source_type: 'url',
      status: 'ready',
      collection_id: null,
      refresh_policy: 'daily',
      last_fetched_at: '2026-01-01T00:00:00.000Z',
      last_changed_at: null,
      next_refresh_at: null,
      refresh_failures: 0,
    }));
    await expect(buildRetrievalScope(scopeSb(rows), 'p1', { freshness: ['fresh'] })).rejects.toMatchObject({
      code: 'knowledge_scope_too_broad',
    });
  });
});

describe('metadata-aware reconciliation (KB10.2)', () => {
  it('drops non-ready, out-of-collection and out-of-type managed candidates', () => {
    const scope = {
      collectionId: COLLECTION,
      uncategorized: false,
      sourceTypes: ['url'],
      freshness: [],
      requestedSourceIds: [],
      effectiveSourceIds: null,
      managedOnly: true,
      empty: false,
    } as const;

    const candidates = [
      candidate(SOURCE_A, '0', 'vector', 0.9),
      candidate(SOURCE_B, '0', 'vector', 0.8),
    ];
    const loaded = new Map<string, ManagedSourceFacts>([
      [SOURCE_A, facts(SOURCE_A, { status: 'processing', sourceType: 'url', collectionId: COLLECTION })],
      [SOURCE_B, facts(SOURCE_B, { status: 'ready', sourceType: 'url', collectionId: 'other' })],
    ]);

    expect(managedIdsFromCandidates(candidates).sort()).toEqual([SOURCE_A, SOURCE_B].sort());
    expect(filterCandidatesToScope(scope, candidates, loaded)).toEqual([]);
  });

  it('keeps a ready in-scope managed candidate and drops system knowledge under a managed-only scope', () => {
    const scope = {
      collectionId: null,
      uncategorized: false,
      sourceTypes: [],
      freshness: [],
      requestedSourceIds: [SOURCE_A],
      effectiveSourceIds: [SOURCE_A],
      managedOnly: true,
      empty: false,
    } as const;

    const loaded = new Map<string, ManagedSourceFacts>([[SOURCE_A, facts(SOURCE_A)]]);
    const kept = filterCandidatesToScope(
      scope,
      [candidate(SOURCE_A, '0', 'vector', 1), systemCandidate('page:https://a', 'vector', 0.5)],
      loaded,
    );
    expect(kept.map((c) => c.key)).toEqual([`${SOURCE_A}::0`]);
  });
});

describe('hybrid pipeline (KB10/KB10.2)', () => {
  it('degrades to lexical candidates when the vector provider fails', async () => {
    const search = vi.fn(async () => {
      throw new Error('Qdrant down');
    });
    const rpc = vi.fn(async () => ({
      data: [{ source_id: SOURCE_A, chunk_index: 0, score: 1.5, content: 'lex' }],
      error: null,
    }));
    const loadSourceFacts = vi.fn(async () => new Map([[SOURCE_A, facts(SOURCE_A)]]));

    const outcome = await retrieveCandidates(
      { provider: fakeProvider(search), sb: fakeSb(rpc), loadSourceFacts },
      await planFor(),
    );

    expect(outcome.diagnostics.vectorFailed).toBe(true);
    expect(outcome.diagnostics.lexicalFailed).toBe(false);
    expect(outcome.candidates.map((c) => c.origin)).toEqual(['lexical']);
    expect(loadSourceFacts).toHaveBeenCalledWith('p1', [SOURCE_A]);
  });

  it('degrades to vector candidates when the lexical RPC fails', async () => {
    const search = vi.fn(async () => [
      { id: 'p', score: 0.5, payload: { source_id: 'page:https://a.example', title: 'A', text: 'vec' } },
    ]);
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'relation missing' } }));

    const outcome = await retrieveCandidates(
      { provider: fakeProvider(search), sb: fakeSb(rpc) },
      await planFor(),
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
      retrieveCandidates({ provider: fakeProvider(search), sb: fakeSb(rpc) }, await planFor()),
    ).rejects.toThrow('Qdrant down');
  });

  it('vector mode never calls lexical and propagates vector errors', async () => {
    const search = vi.fn(async () => {
      throw new Error('Qdrant down');
    });
    const rpc = vi.fn();

    await expect(
      retrieveCandidates(
        { provider: fakeProvider(search), sb: fakeSb(rpc) },
        await planFor({ mode: 'vector' }),
      ),
    ).rejects.toThrow('Qdrant down');
    expect(rpc).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  });

  it('hybrid mode requests the bounded vector candidate window', async () => {
    const search = vi.fn(async () => []);
    const rpc = vi.fn(async () => ({ data: [], error: null }));

    await retrieveCandidates(
      { provider: fakeProvider(search), sb: fakeSb(rpc) },
      await planFor({ limit: 5 }),
    );

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: KNOWLEDGE_RETRIEVAL_VECTOR_CANDIDATES }));
    expect(rpc).toHaveBeenCalledWith(
      'seo_knowledge_lexical_search',
      expect.objectContaining({ p_limit: KNOWLEDGE_RETRIEVAL_LEXICAL_CANDIDATES }),
    );
  });

  it('filters metadata before fusion so a non-ready chunk cannot influence ranking', async () => {
    const search = vi.fn(async () => [
      { id: 'p', score: 0.9, payload: { source_id: sourceExternalId(SOURCE_A), text: 'vec', chunk_index: 0 } },
    ]);
    const rpc = vi.fn(async () => ({
      data: [{ source_id: SOURCE_A, chunk_index: 0, score: 2.0, content: 'lex' }],
      error: null,
    }));
    // The managed source is not ready, so both origins' candidates are dropped.
    const loadSourceFacts = vi.fn(async () => new Map([[SOURCE_A, facts(SOURCE_A, { status: 'failed' })]]));

    const outcome = await retrieveCandidates(
      { provider: fakeProvider(search), sb: fakeSb(rpc), loadSourceFacts },
      await planFor(),
    );

    expect(outcome.candidates).toEqual([]);
    expect(outcome.diagnostics.vectorCandidates).toBe(0);
    expect(outcome.diagnostics.lexicalCandidates).toBe(0);
    expect(outcome.diagnostics.fused).toBe(false);
  });

  it('does not call any origin when the canonical scope is provably empty', async () => {
    const search = vi.fn(async () => []);
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const plan = await planFor({ filter: { freshness: ['fresh'] } }, scopeSb([]));

    const outcome = await retrieveCandidates({ provider: fakeProvider(search), sb: fakeSb(rpc) }, plan);

    expect(plan.scope.empty).toBe(true);
    expect(outcome.candidates).toEqual([]);
    expect(outcome.diagnostics.derivedScope).toBe(true);
    expect(search).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('passes the same canonical filter to both origins', async () => {
    const search = vi.fn(async () => []);
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const plan = await planFor({ filter: { sourceTypes: ['url'], collectionId: COLLECTION } });

    await retrieveCandidates({ provider: fakeProvider(search), sb: fakeSb(rpc) }, plan);

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { collectionId: COLLECTION, sourceTypes: ['url'] } }),
    );
    expect(rpc).toHaveBeenCalledWith(
      'seo_knowledge_lexical_search',
      expect.objectContaining({ p_collection_id: COLLECTION, p_source_types: ['url'], p_source_ids: null }),
    );
  });
});

// ---------------------------------------------------------------------------
// KB10.3 - optional reranking after reconcile + fusion
// ---------------------------------------------------------------------------

describe('reranking integration (KB10.3)', () => {
  function reranker(overrides: Partial<KnowledgeReranker> = {}): KnowledgeReranker {
    return {
      id: 'fake',
      name: 'Fake',
      isConfigured: () => true,
      rerank: vi.fn(async () => ({ rankings: [] })),
      ...overrides,
    } as KnowledgeReranker;
  }

  function twoHits(): { search: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> } {
    const search = vi.fn(async () => [
      { id: 'p1', score: 0.9, payload: { source_id: sourceExternalId(SOURCE_A), text: 'vec a', chunk_index: 0 } },
      { id: 'p2', score: 0.8, payload: { source_id: sourceExternalId(SOURCE_B), text: 'vec b', chunk_index: 0 } },
    ]);
    const rpc = vi.fn(async () => ({
      data: [
        { source_id: SOURCE_A, chunk_index: 0, score: 2.0, content: 'lex a' },
        { source_id: SOURCE_B, chunk_index: 0, score: 1.0, content: 'lex b' },
      ],
      error: null,
    }));
    return { search, rpc };
  }

  it('reranks the fused order and reports that reranking was applied', async () => {
    const { search, rpc } = twoHits();
    const loadSourceFacts = vi.fn(
      async () =>
        new Map([
          [SOURCE_A, facts(SOURCE_A)],
          [SOURCE_B, facts(SOURCE_B)],
        ]),
    );
    const fake = reranker({
      rerank: vi.fn(async (req: KnowledgeRerankRequest) => ({
        rankings: [...req.candidates].reverse().map((c, i) => ({ id: c.id, score: 100 - i })),
      })),
    });

    const outcome = await retrieveCandidates(
      { provider: fakeProvider(search), sb: fakeSb(rpc), loadSourceFacts, reranker: fake },
      await planFor(),
    );

    expect(outcome.diagnostics.rerankApplied).toBe(true);
    expect(outcome.diagnostics.rerankFailed).toBe(false);
    expect(outcome.candidates.map((c) => c.sourceId)).toEqual([SOURCE_B, SOURCE_A]);
    expect(outcome.candidates).toHaveLength(2);
  });

  it('keeps the RRF order when no reranker is configured', async () => {
    const { search, rpc } = twoHits();
    const loadSourceFacts = vi.fn(
      async () => new Map([[SOURCE_A, facts(SOURCE_A)], [SOURCE_B, facts(SOURCE_B)]]),
    );

    const outcome = await retrieveCandidates(
      { provider: fakeProvider(search), sb: fakeSb(rpc), loadSourceFacts },
      await planFor(),
    );

    expect(outcome.diagnostics.rerankApplied).toBe(false);
    expect(outcome.candidates.map((c) => c.sourceId)).toEqual([SOURCE_A, SOURCE_B]);
  });

  it('keeps the RRF order when the reranker fails', async () => {
    const { search, rpc } = twoHits();
    const loadSourceFacts = vi.fn(
      async () => new Map([[SOURCE_A, facts(SOURCE_A)], [SOURCE_B, facts(SOURCE_B)]]),
    );
    const fake = reranker({
      rerank: vi.fn(async () => {
        throw new Error('rerank down');
      }),
    });

    const outcome = await retrieveCandidates(
      { provider: fakeProvider(search), sb: fakeSb(rpc), loadSourceFacts, reranker: fake },
      await planFor(),
    );

    expect(outcome.diagnostics.rerankApplied).toBe(false);
    expect(outcome.diagnostics.rerankFailed).toBe(true);
    expect(outcome.candidates.map((c) => c.sourceId)).toEqual([SOURCE_A, SOURCE_B]);
  });

  it('keeps the RRF order when the reranker returns an unusable ranking', async () => {
    const { search, rpc } = twoHits();
    const loadSourceFacts = vi.fn(
      async () => new Map([[SOURCE_A, facts(SOURCE_A)], [SOURCE_B, facts(SOURCE_B)]]),
    );
    const fake = reranker({ rerank: vi.fn(async () => ({ rankings: [{ id: 'foreign', score: 1 }] })) });

    const outcome = await retrieveCandidates(
      { provider: fakeProvider(search), sb: fakeSb(rpc), loadSourceFacts, reranker: fake },
      await planFor(),
    );

    expect(outcome.diagnostics.rerankApplied).toBe(false);
    expect(outcome.diagnostics.rerankFailed).toBe(true);
    expect(outcome.candidates.map((c) => c.sourceId)).toEqual([SOURCE_A, SOURCE_B]);
  });

  it('only offers post-reconcile candidates to the reranker', async () => {
    const search = vi.fn(async () => [
      { id: 'p1', score: 0.9, payload: { source_id: sourceExternalId(SOURCE_A), text: 'vec a', chunk_index: 0 } },
      { id: 'p2', score: 0.8, payload: { source_id: sourceExternalId(SOURCE_B), text: 'vec b', chunk_index: 0 } },
    ]);
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const loadSourceFacts = vi.fn(
      async () =>
        new Map([
          [SOURCE_A, facts(SOURCE_A)],
          [SOURCE_B, facts(SOURCE_B, { status: 'failed' })],
        ]),
    );
    const fake = reranker({
      rerank: vi.fn(async (req: KnowledgeRerankRequest) => ({
        rankings: req.candidates.map((c) => ({ id: c.id, score: 1 })),
      })),
    });

    const outcome = await retrieveCandidates(
      { provider: fakeProvider(search), sb: fakeSb(rpc), loadSourceFacts, reranker: fake },
      await planFor(),
    );

    const request = vi.mocked(fake.rerank).mock.calls[0]![0];
    expect(request.candidates.map((c) => c.id)).toEqual([`${SOURCE_A}::0`]);
    expect(outcome.candidates.map((c) => c.sourceId)).toEqual([SOURCE_A]);
  });
});
