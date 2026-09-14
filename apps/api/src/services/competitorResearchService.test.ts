/**
 * Competitor research service tests (KW3). They prove both modes stay on the
 * one existing `competitor_research` job path: normalize/validate the domain,
 * cap the competitor selection, resolve the run by its job id, keep raw
 * provider errors out of the read model and never cross project boundaries.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COMPETITOR_RESEARCH_MAX_CANDIDATES,
  COMPETITOR_RESEARCH_MAX_COMPETITORS,
  COMPETITOR_RESEARCH_RUN_MAX_GAPS,
} from '@seo/contracts';
import {
  COMPETITOR_RESEARCH_JOB_TYPE,
  assertDomain,
  normalizeDomain,
  readCompetitorResearchRun,
  startCompetitorDiscovery,
  startCompetitorGap,
} from './competitorResearchService.js';
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
    seo_domains: [{ id: 'dom-1', project_id: PROJECT, domain: 'example.com', is_primary: true }],
  };
}

/** Stores with a Search Console property linked to the project. */
function gscStores(siteUrl: string, seoDomain = 'legacy.example.org'): Store {
  return {
    ...baseStores(),
    seo_domains: [{ id: 'dom-1', project_id: PROJECT, domain: seoDomain, is_primary: true }],
    seo_project_properties: [
      { id: 'link-1', project_id: PROJECT, property_id: 'prop-1', is_primary: true, created_at: '2026-01-01' },
    ],
    seo_gsc_properties: [{ id: 'prop-1', site_url: siteUrl }],
  };
}

function containerWith(
  stores: Store,
  opts: { registered?: boolean; enqueued?: JobRecord | null; get?: JobRecord | null } = {},
) {
  const enqueue = vi.fn(
    async (input: Record<string, unknown>) =>
      opts.enqueued ??
      ({
        id: 'job-1',
        project_id: input.project_id,
        status: 'queued',
        job_type: input.job_type,
        params: input.params,
        result: null,
        completed_at: null,
        queued_at: '2026-09-13T10:00:00.000Z',
      } as unknown as JobRecord),
  );
  const get = vi.fn(async () => opts.get ?? null);
  return {
    container: {
      sb: fakeSb(stores),
      registry: {
        getDataSource: (id: string) => (opts.registered === false ? undefined : { id }),
      },
      credentials: { reader: () => ({}) },
      jobStore: { enqueue, get },
    } as never,
    enqueue,
    get,
  };
}

function jobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    project_id: PROJECT,
    integration_id: 'int-1',
    data_source_id: 'ds-1',
    provider: 'dataforseo',
    job_type: COMPETITOR_RESEARCH_JOB_TYPE,
    status: 'completed',
    params: { mode: 'discover', domain: 'example.com' },
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

describe('normalizeDomain / assertDomain', () => {
  it('strips scheme, www, port, path and casing', () => {
    expect(normalizeDomain('  HTTPS://WWW.Example.COM:443/path?q=1 ')).toBe('example.com');
  });

  it('rejects blank and malformed domains', () => {
    expect(() => assertDomain('   ')).toThrow();
    expect(normalizeDomain('not a domain')).toBe('not a domain');
    expect(() => assertDomain('not a domain')).toThrow();
    expect(() => assertDomain('localhost')).toThrow();
  });
});

describe('startCompetitorDiscovery', () => {
  it('uses the project domain and enqueues exactly one discover job', async () => {
    const { container, enqueue } = containerWith(baseStores());
    const started = await startCompetitorDiscovery(container, PROJECT, USER);

    expect(started).toEqual({ jobId: 'job-1', status: 'queued', mode: 'discover', domain: 'example.com' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: PROJECT,
        job_type: COMPETITOR_RESEARCH_JOB_TYPE,
        provider: 'dataforseo',
        params: { mode: 'discover', domain: 'example.com' },
      }),
    );
  });

  it('prefers an explicit domain override', async () => {
    const { container, enqueue } = containerWith(baseStores());
    await startCompetitorDiscovery(container, PROJECT, USER, 'https://rival.com/x');
    expect(enqueue.mock.calls[0][0].params).toEqual({ mode: 'discover', domain: 'rival.com' });
  });

  it('derives the domain from the linked Search Console property', async () => {
    const { container, enqueue } = containerWith(gscStores('https://www.example.com/'));
    const started = await startCompetitorDiscovery(container, PROJECT, USER);
    expect(started.domain).toBe('example.com');
    expect(enqueue.mock.calls[0][0].params).toEqual({ mode: 'discover', domain: 'example.com' });
  });

  it('normalizes an sc-domain Search Console property', async () => {
    const stores = gscStores('sc-domain:example.com');
    stores.seo_domains = [];
    const { container } = containerWith(stores);
    const started = await startCompetitorDiscovery(container, PROJECT, USER);
    expect(started.domain).toBe('example.com');
  });

  it('tells the user to connect a property when the project has neither a property nor a domain', async () => {
    const stores = baseStores();
    stores.seo_domains = [];
    const { container, enqueue } = containerWith(stores);
    await expect(startCompetitorDiscovery(container, PROJECT, USER)).rejects.toMatchObject({ status: 400 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reports not configured when the provider is not registered', async () => {
    const { container, enqueue } = containerWith(baseStores(), { registered: false });
    await expect(startCompetitorDiscovery(container, PROJECT, USER, 'example.com')).rejects.toMatchObject({
      status: 503,
      code: 'not_configured',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('startCompetitorGap', () => {
  it('normalizes and de-duplicates competitors and enqueues one gap job', async () => {
    const { container, enqueue } = containerWith(baseStores());
    const started = await startCompetitorGap(container, PROJECT, USER, undefined, [
      'https://WWW.Rival.com/a',
      'rival.com',
      'other.com',
    ]);

    expect(started).toEqual({
      jobId: 'job-1',
      status: 'queued',
      mode: 'gap',
      domain: 'example.com',
      competitors: ['rival.com', 'other.com'],
    });
    expect(enqueue.mock.calls[0][0].params).toEqual({
      mode: 'gap',
      domain: 'example.com',
      competitors: ['rival.com', 'other.com'],
    });
  });

  it('rejects an empty competitor list', async () => {
    const { container, enqueue } = containerWith(baseStores());
    await expect(startCompetitorGap(container, PROJECT, USER, undefined, [])).rejects.toMatchObject({ status: 400 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects the project domain as its own competitor', async () => {
    const { container } = containerWith(baseStores());
    await expect(startCompetitorGap(container, PROJECT, USER, undefined, ['example.com'])).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects more than the competitor cap', async () => {
    const { container, enqueue } = containerWith(baseStores());
    const tooMany = Array.from({ length: COMPETITOR_RESEARCH_MAX_COMPETITORS + 1 }, (_, i) => `rival${i}.com`);
    await expect(startCompetitorGap(container, PROJECT, USER, undefined, tooMany)).rejects.toMatchObject({ status: 400 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('readCompetitorResearchRun', () => {
  it('projects a completed discovery run with bounded candidates', async () => {
    const get = jobRecord({
      result: {
        mode: 'discover',
        domain: 'example.com',
        count: 1,
        competitors: [{ domain: 'rival.com', sharedKeywords: 1842, keywordsCount: 5200, avgPosition: 12.4, etv: 900 }],
      },
    });
    const { container } = containerWith(baseStores(), { get });
    const run = await readCompetitorResearchRun(container, PROJECT, 'job-1');
    expect(run).toEqual({
      jobId: 'job-1',
      mode: 'discover',
      status: 'completed',
      domain: 'example.com',
      candidates: [{ domain: 'rival.com', sharedKeywords: 1842, keywordsCount: 5200, avgPosition: 12.4, etv: 900 }],
      selectedCompetitors: [],
      gaps: [],
      count: 1,
      error: null,
      createdAt: '2026-09-13T10:00:00.000Z',
      completedAt: '2026-09-13T10:00:10.000Z',
    });
  });

  it('projects a completed gap run with bounded gaps', async () => {
    const get = jobRecord({
      params: { mode: 'gap', domain: 'example.com', competitors: ['rival.com'] },
      result: {
        mode: 'gap',
        domain: 'example.com',
        competitors: ['rival.com'],
        count: 1,
        gaps: [{ keyword: 'blue widgets', searchVolume: 2400, difficulty: 42, cpc: 1.2, competitorDomain: 'rival.com', position: 4 }],
      },
    });
    const { container } = containerWith(baseStores(), { get });
    const run = await readCompetitorResearchRun(container, PROJECT, 'job-1');
    expect(run.mode).toBe('gap');
    expect(run.selectedCompetitors).toEqual(['rival.com']);
    expect(run.gaps).toEqual([
      { keyword: 'blue widgets', searchVolume: 2400, difficulty: 42, cpc: 1.2, competitorDomain: 'rival.com', position: 4 },
    ]);
    expect(run.candidates).toEqual([]);
  });

  it('caps candidate rows to the run limit', async () => {
    const competitors = Array.from({ length: COMPETITOR_RESEARCH_MAX_CANDIDATES + 5 }, (_, i) => ({
      domain: `rival${i}.com`,
      sharedKeywords: i,
      keywordsCount: null,
      avgPosition: null,
      etv: null,
    }));
    const get = jobRecord({ result: { mode: 'discover', domain: 'example.com', count: competitors.length, competitors } });
    const { container } = containerWith(baseStores(), { get });
    const run = await readCompetitorResearchRun(container, PROJECT, 'job-1');
    expect(run.candidates).toHaveLength(COMPETITOR_RESEARCH_MAX_CANDIDATES);
  });

  it('caps gap rows to the run limit', async () => {
    const gaps = Array.from({ length: COMPETITOR_RESEARCH_RUN_MAX_GAPS + 5 }, (_, i) => ({
      keyword: `kw-${i}`,
      searchVolume: i,
      difficulty: null,
      cpc: null,
      competitorDomain: 'rival.com',
      position: 3,
    }));
    const get = jobRecord({
      params: { mode: 'gap', domain: 'example.com', competitors: ['rival.com'] },
      result: { mode: 'gap', domain: 'example.com', count: gaps.length, gaps },
    });
    const { container } = containerWith(baseStores(), { get });
    const run = await readCompetitorResearchRun(container, PROJECT, 'job-1');
    expect(run.gaps).toHaveLength(COMPETITOR_RESEARCH_RUN_MAX_GAPS);
  });

  it('shows nothing until the run completes', async () => {
    const get = jobRecord({ status: 'running', completed_at: null, result: null });
    const { container } = containerWith(baseStores(), { get });
    const run = await readCompetitorResearchRun(container, PROJECT, 'job-1');
    expect(run.status).toBe('running');
    expect(run.candidates).toEqual([]);
    expect(run.gaps).toEqual([]);
    expect(run.count).toBe(0);
  });

  it('reports a safe generic error for a failed run, never the raw provider message', async () => {
    const get = jobRecord({
      status: 'failed',
      result: null,
      error: {
        provider: 'dataforseo',
        operation: 'domain_intersection',
        message: 'HTTP 500 https://api.dataforseo.com/v3/... key=SECRET',
        http_status: 500,
        code: null,
        retryable: true,
        occurred_at: '2026-09-13T10:00:10.000Z',
      },
    });
    const { container } = containerWith(baseStores(), { get });
    const run = await readCompetitorResearchRun(container, PROJECT, 'job-1');
    expect(run.error).toBe('Competitor research failed. Please try again.');
    expect(JSON.stringify(run)).not.toContain('SECRET');
    expect(JSON.stringify(run)).not.toContain('api.dataforseo.com');
  });

  it('does not expose a run that belongs to another project', async () => {
    const get = jobRecord({ project_id: OTHER_PROJECT });
    const { container } = containerWith(baseStores(), { get });
    await expect(readCompetitorResearchRun(container, PROJECT, 'job-1')).rejects.toMatchObject({ status: 404 });
  });

  it('does not expose a non-competitor job', async () => {
    const get = jobRecord({ job_type: 'gsc_sync' });
    const { container } = containerWith(baseStores(), { get });
    await expect(readCompetitorResearchRun(container, PROJECT, 'job-1')).rejects.toMatchObject({ status: 404 });
  });
});
