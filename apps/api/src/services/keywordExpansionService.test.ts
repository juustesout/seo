/**
 * Keyword expansion service tests (KW4). They pin the boundaries that matter
 * most: the legacy-vs-expansion discriminator (`methods` absent vs present),
 * seed/method caps, the deterministic merge (first non-null in canonical method
 * order), result-view filtering over a bounded snapshot, and an explicit save
 * that verifies keywords against the exact run and derives provenance itself.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  KEYWORD_EXPANSION_MAX_LIMIT_PER_METHOD,
  KEYWORD_EXPANSION_MAX_SEEDS,
  KEYWORD_EXPANSION_METHODS,
  type KeywordResearchResult,
} from '@seo/contracts';
import {
  KEYWORD_EXPANSION_JOB_TYPE,
  applyKeywordQuery,
  mergeExpansionCandidates,
  readKeywordExpansionRun,
  saveKeywordExpansionSelection,
  startKeywordExpansion,
} from './keywordExpansionService.js';
import { SeoWriter } from '../persistence/seoWriter.js';
import type { JobRecord } from '../jobs/types.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const USER = 'user-1';

type Store = Record<string, Record<string, unknown>[]>;

function fakeSb(stores: Store) {
  return {
    from(table: string) {
      const all = stores[table] ?? [];
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: all.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      };
      return builder;
    },
  };
}

function baseStores(): Store {
  return {
    seo_integrations: [{ id: 'int-1', project_id: PROJECT, provider_type: 'dataforseo', status: 'connected' }],
    seo_data_sources: [{ id: 'ds-1', project_id: PROJECT, provider_type: 'dataforseo' }],
  };
}

function containerWith(stores: Store, opts: { enqueued?: JobRecord | null; get?: JobRecord | null } = {}) {
  const enqueue = vi.fn(async (input: Record<string, unknown>) =>
    ({
      id: 'job-1',
      project_id: input.project_id,
      status: 'queued',
      job_type: input.job_type,
      params: input.params,
      result: null,
      completed_at: null,
      queued_at: '2026-09-13T10:00:00.000Z',
    }) as unknown as JobRecord,
  );
  const get = vi.fn(async () => opts.get ?? null);
  return {
    container: {
      sb: fakeSb(stores),
      registry: { getDataSource: () => ({ id: 'dataforseo' }) },
      credentials: { reader: () => ({}) },
      jobStore: { enqueue, get },
    } as never,
    enqueue,
    get,
  };
}

function result(keyword: string, overrides: Partial<KeywordResearchResult> = {}): KeywordResearchResult {
  return {
    keyword,
    location_code: 2840,
    language_code: 'en',
    search_volume: 100,
    cpc: 1,
    competition: 'LOW',
    difficulty: 20,
    serp: [],
    keyword_intents: ['informational'],
    ...overrides,
  };
}

function expansionJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    project_id: PROJECT,
    integration_id: 'int-1',
    data_source_id: 'ds-1',
    provider: 'dataforseo',
    job_type: KEYWORD_EXPANSION_JOB_TYPE,
    status: 'completed',
    params: { seeds: ['seo tools'], methods: ['suggestions', 'related', 'ideas'], relatedDepth: 1, limitPerMethod: 200 },
    progress: 100,
    message: null,
    result: null,
    error: null,
    queued_at: '2026-09-13T10:00:00.000Z',
    started_at: '2026-09-13T10:00:01.000Z',
    completed_at: '2026-09-13T10:00:10.000Z',
    run_after: '2026-09-13T10:00:00.000Z',
    retry_count: 0,
    max_retries: 3,
    created_by: USER,
    ...overrides,
  };
}

describe('startKeywordExpansion', () => {
  it('normalizes seeds, defaults and enqueues an explicit-methods job', async () => {
    const { container, enqueue } = containerWith(baseStores());
    const started = await startKeywordExpansion(container, PROJECT, USER, {
      seeds: ['  seo tools ', 'seo tools', 'keyword research'],
      methods: ['ideas', 'suggestions', 'ideas'],
    });

    expect(started).toEqual({
      jobId: 'job-1',
      status: 'queued',
      seeds: ['seo tools', 'keyword research'],
      methods: ['suggestions', 'ideas'],
    });
    expect(enqueue.mock.calls[0][0].params).toEqual({
      seeds: ['seo tools', 'keyword research'],
      methods: ['suggestions', 'ideas'],
      relatedDepth: 1,
      limitPerMethod: KEYWORD_EXPANSION_MAX_LIMIT_PER_METHOD,
    });
  });

  it('pushes an explicit provider min volume as a discovery filter', async () => {
    const { container, enqueue } = containerWith(baseStores());
    await startKeywordExpansion(container, PROJECT, USER, {
      seeds: ['seo tools'],
      methods: ['suggestions'],
      providerMinVolume: 250.9,
    });
    expect(enqueue.mock.calls[0][0].params).toMatchObject({ providerMinVolume: 250 });
  });

  it('rejects an empty seed list, an unknown method and too many seeds', async () => {
    const { container, enqueue } = containerWith(baseStores());
    await expect(
      startKeywordExpansion(container, PROJECT, USER, { seeds: [], methods: ['suggestions'] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      startKeywordExpansion(container, PROJECT, USER, { seeds: ['a'], methods: ['nope' as never] }),
    ).rejects.toMatchObject({ status: 400 });
    const tooMany = Array.from({ length: KEYWORD_EXPANSION_MAX_SEEDS + 1 }, (_, i) => `seed ${i}`);
    await expect(
      startKeywordExpansion(container, PROJECT, USER, { seeds: tooMany, methods: ['suggestions'] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('mergeExpansionCandidates', () => {
  it('unions methods/seeds and keeps the first non-null metric in canonical order', () => {
    const merged = mergeExpansionCandidates([
      { method: 'ideas', seeds: ['a'], results: [result('Widget', { search_volume: 1200 })] },
      { method: 'suggestions', seeds: ['b'], results: [result('widget', { search_volume: 1000, cpc: null })] },
      { method: 'related', seeds: ['a'], results: [result('WIDGET', { search_volume: 900, difficulty: null })] },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      keyword: 'widget',
      searchVolume: 1000,
      difficulty: 20,
      cpc: 1,
      competition: 'LOW',
      intent: 'informational',
      methods: ['suggestions', 'related', 'ideas'],
      seeds: ['b', 'a'],
    });
  });

  it('is deterministic regardless of the order methods are supplied in', () => {
    const out = (method: 'suggestions' | 'related' | 'ideas', keyword: string, volume: number) => ({
      method,
      seeds: [keyword],
      results: [result(keyword, { search_volume: volume })],
    });
    const a = mergeExpansionCandidates([out('related', 'x', 900), out('suggestions', 'x', 1000)]);
    const b = mergeExpansionCandidates([out('suggestions', 'x', 1000), out('related', 'x', 900)]);
    expect(a).toEqual(b);
    expect(a[0].searchVolume).toBe(1000);
  });

  it('lets a later method fill a null it did not have, but never overwrite a real value', () => {
    const merged = mergeExpansionCandidates([
      { method: 'suggestions', seeds: ['a'], results: [result('kw', { search_volume: null, difficulty: null })] },
      { method: 'ideas', seeds: ['a'], results: [result('kw', { search_volume: 5000, difficulty: 77 })] },
    ]);
    expect(merged[0].searchVolume).toBe(5000);
    expect(merged[0].difficulty).toBe(77);
  });

  it('sorts by volume descending with nulls last and drops nothing valid', () => {
    const merged = mergeExpansionCandidates([
      {
        method: 'suggestions',
        seeds: ['a'],
        results: [result('low', { search_volume: 10 }), result('none', { search_volume: null }), result('high', { search_volume: 9000 })],
      },
    ]);
    expect(merged.map((c) => c.keyword)).toEqual(['high', 'low', 'none']);
  });
});

describe('applyKeywordQuery', () => {
  const candidates = [
    { keyword: 'a', searchVolume: 10, difficulty: null, cpc: null, competition: null, intent: null, methods: ['suggestions' as const], seeds: ['s'] },
    { keyword: 'b', searchVolume: 500, difficulty: null, cpc: null, competition: null, intent: null, methods: ['ideas' as const], seeds: ['s'] },
    { keyword: 'c', searchVolume: null, difficulty: null, cpc: null, competition: null, intent: null, methods: ['related' as const], seeds: ['s'] },
  ];

  it('excludes unknown volumes when a minimum is set', () => {
    expect(applyKeywordQuery(candidates, { minVolume: 100 }).map((c) => c.keyword)).toEqual(['b']);
  });

  it('filters by method and sorts deterministically', () => {
    expect(applyKeywordQuery(candidates, { method: 'suggestions' }).map((c) => c.keyword)).toEqual(['a']);
    expect(applyKeywordQuery(candidates, { sort: 'volume_asc' }).map((c) => c.keyword)).toEqual(['a', 'b', 'c']);
    expect(applyKeywordQuery(candidates, { sort: 'keyword_asc' }).map((c) => c.keyword)).toEqual(['a', 'b', 'c']);
  });
});

describe('readKeywordExpansionRun', () => {
  it('projects a completed expansion run with candidates and per-method status', async () => {
    const get = expansionJob({
      result: {
        seeds: ['seo tools'],
        methods: KEYWORD_EXPANSION_METHODS,
        methodStatus: {
          suggestions: { status: 'success', count: 2 },
          related: { status: 'failed', count: 0 },
          ideas: { status: 'success', count: 1 },
        },
        candidates: [
          { keyword: 'seo software', searchVolume: 1200, difficulty: 40, cpc: 2.5, competition: 'HIGH', intent: 'commercial', methods: ['suggestions'], seeds: ['seo tools'] },
        ],
        count: 1,
      },
    });
    const { container } = containerWith(baseStores(), { get });
    const run = await readKeywordExpansionRun(container, PROJECT, 'job-1');
    expect(run.status).toBe('completed');
    expect(run.methods).toEqual(KEYWORD_EXPANSION_METHODS);
    expect(run.methodStatus.related).toEqual({ status: 'failed', count: 0 });
    expect(run.candidates[0].keyword).toBe('seo software');
    expect(run.count).toBe(1);
  });

  it('narrows the snapshot with result-view filters without a provider call', async () => {
    const get = expansionJob({
      result: {
        candidates: [
          { keyword: 'a', searchVolume: 10, methods: ['suggestions'], seeds: ['s'] },
          { keyword: 'b', searchVolume: 500, methods: ['ideas'], seeds: ['s'] },
        ],
      },
    });
    const { container } = containerWith(baseStores(), { get });
    const run = await readKeywordExpansionRun(container, PROJECT, 'job-1', { minVolume: 100 });
    expect(run.candidates.map((c) => c.keyword)).toEqual(['b']);
    expect(run.count).toBe(1);
  });

  it('treats a legacy KW2 job (no methods) as not found', async () => {
    const get = expansionJob({ params: { seeds: ['seo'], keywords: [] }, result: { keywords: [] } });
    const { container } = containerWith(baseStores(), { get });
    await expect(readKeywordExpansionRun(container, PROJECT, 'job-1')).rejects.toMatchObject({ status: 404 });
  });

  it('does not expose a run from another project and reports a safe failure', async () => {
    const other = expansionJob({ project_id: OTHER_PROJECT });
    const { container: c1 } = containerWith(baseStores(), { get: other });
    await expect(readKeywordExpansionRun(c1, PROJECT, 'job-1')).rejects.toMatchObject({ status: 404 });

    const failed = expansionJob({
      status: 'failed',
      result: null,
      error: { provider: 'dataforseo', operation: 'related_keywords', message: 'HTTP 500 https://api.dataforseo.com/key=SECRET', http_status: 500, code: null, retryable: true, occurred_at: '2026-09-13T10:00:10.000Z' },
    });
    const { container: c2 } = containerWith(baseStores(), { get: failed });
    const run = await readKeywordExpansionRun(c2, PROJECT, 'job-1');
    expect(run.error).toBe('Keyword expansion failed. Please try again.');
    expect(JSON.stringify(run)).not.toContain('SECRET');
    expect(JSON.stringify(run)).not.toContain('api.dataforseo.com');
  });
});

describe('saveKeywordExpansionSelection', () => {
  function withCandidates() {
    return expansionJob({
      result: {
        methodStatus: { suggestions: { status: 'success', count: 1 } },
        candidates: [
          {
            keyword: 'seo software',
            searchVolume: 1200,
            difficulty: 40,
            cpc: 2.5,
            competition: 'HIGH',
            intent: 'commercial',
            methods: ['suggestions', 'related'],
            seeds: ['seo tools'],
          },
        ],
      },
    });
  }

  it('verifies keywords against the run and derives provenance server-side', async () => {
    const spy = vi.spyOn(SeoWriter.prototype, 'persistExpansionKeywords').mockResolvedValue(undefined);
    try {
      const { container } = containerWith(baseStores(), { get: withCandidates() });
      const out = await saveKeywordExpansionSelection(container, PROJECT, 'job-1', ['  SEO software ']);
      expect(out).toEqual({ saved: 1, skipped: 0 });
      expect(spy).toHaveBeenCalledTimes(1);
      const [projectId, rows] = spy.mock.calls[0];
      expect(projectId).toBe(PROJECT);
      expect(rows[0]).toMatchObject({ keyword: 'seo software', volume: 1200, difficulty: 40, cpc: 2.5, competition: 'HIGH', intent: 'commercial' });
      expect(rows[0].meta).toEqual({
        discovered_via: 'keyword_expansion',
        run_job_id: 'job-1',
        methods: ['suggestions', 'related'],
        seeds: ['seo tools'],
        related_depth: 1,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a keyword that is not part of the run and writes nothing', async () => {
    const spy = vi.spyOn(SeoWriter.prototype, 'persistExpansionKeywords').mockResolvedValue(undefined);
    try {
      const { container } = containerWith(baseStores(), { get: withCandidates() });
      await expect(
        saveKeywordExpansionSelection(container, PROJECT, 'job-1', ['seo software', 'not in run']),
      ).rejects.toMatchObject({ status: 400, details: { invalid: ['not in run'] } });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses to save from an incomplete run', async () => {
    const get = expansionJob({ status: 'running', completed_at: null, result: null });
    const { container } = containerWith(baseStores(), { get });
    await expect(saveKeywordExpansionSelection(container, PROJECT, 'job-1', ['seo software'])).rejects.toMatchObject({
      status: 409,
    });
  });

  it('does not save into another project and ignores a legacy job', async () => {
    const { container } = containerWith(baseStores(), { get: expansionJob({ project_id: OTHER_PROJECT }) });
    await expect(saveKeywordExpansionSelection(container, PROJECT, 'job-1', ['seo software'])).rejects.toMatchObject({
      status: 404,
    });
    const legacy = expansionJob({ params: { seeds: ['seo'] }, result: { keywords: [] } });
    const { container: c2 } = containerWith(baseStores(), { get: legacy });
    await expect(saveKeywordExpansionSelection(c2, PROJECT, 'job-1', ['seo software'])).rejects.toMatchObject({
      status: 404,
    });
  });

  it('counts duplicate selections as skipped', async () => {
    const spy = vi.spyOn(SeoWriter.prototype, 'persistExpansionKeywords').mockResolvedValue(undefined);
    try {
      const { container } = containerWith(baseStores(), { get: withCandidates() });
      const out = await saveKeywordExpansionSelection(container, PROJECT, 'job-1', ['seo software', 'SEO SOFTWARE']);
      expect(out).toEqual({ saved: 1, skipped: 1 });
      expect(spy.mock.calls[0][1]).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
