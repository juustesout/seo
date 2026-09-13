/**
 * Keyword research service tests (KW2). They prove the slice stays on the one
 * existing execution path: normalize/bound the seed, enqueue exactly one
 * dataforseo_keyword_research job, resolve the run by its job id, keep raw
 * provider errors out of the read model and never cross project boundaries.
 */
import { describe, expect, it, vi } from 'vitest';
import { KEYWORD_RESEARCH_RUN_MAX_KEYWORDS } from '@seo/contracts';
import {
  KEYWORD_RESEARCH_JOB_TYPE,
  normalizeSeed,
  readKeywordResearchRun,
  startKeywordResearch,
} from './keywordResearchService.js';
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

function containerWith(stores: Store, opts: { registered?: boolean; enqueued?: JobRecord | null; get?: JobRecord | null } = {}) {
  const enqueue = vi.fn(async (input: Record<string, unknown>) =>
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
    job_type: KEYWORD_RESEARCH_JOB_TYPE,
    status: 'completed',
    params: { seeds: ['seo tools'] },
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

describe('normalizeSeed', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeSeed('  seo   tools \n')).toBe('seo tools');
  });
});

describe('startKeywordResearch', () => {
  it('rejects an empty seed', async () => {
    const { container, enqueue } = containerWith(baseStores());
    await expect(startKeywordResearch(container, PROJECT, USER, '   ')).rejects.toMatchObject({ status: 400 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects an over-long seed', async () => {
    const { container } = containerWith(baseStores());
    await expect(startKeywordResearch(container, PROJECT, USER, 'x'.repeat(201))).rejects.toMatchObject({ status: 400 });
  });

  it('enqueues exactly one existing keyword-research job with the normalized seed', async () => {
    const { container, enqueue } = containerWith(baseStores());
    const started = await startKeywordResearch(container, PROJECT, USER, '  seo   tools ');

    expect(started).toEqual({ jobId: 'job-1', status: 'queued', seed: 'seo tools' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: PROJECT,
        job_type: KEYWORD_RESEARCH_JOB_TYPE,
        provider: 'dataforseo',
        data_source_id: 'ds-1',
        created_by: USER,
        params: { seeds: ['seo tools'] },
      }),
    );
  });

  it('reports not configured when the provider is not registered', async () => {
    const { container, enqueue } = containerWith(baseStores(), { registered: false });
    await expect(startKeywordResearch(container, PROJECT, USER, 'seo tools')).rejects.toMatchObject({
      status: 503,
      code: 'not_configured',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses when no dataforseo integration is connected', async () => {
    const stores = baseStores();
    stores.seo_integrations = [];
    const { container, enqueue } = containerWith(stores);
    await expect(startKeywordResearch(container, PROJECT, USER, 'seo tools')).rejects.toMatchObject({ status: 400 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('readKeywordResearchRun', () => {
  it('projects a completed run with bounded keyword rows', async () => {
    const get = jobRecord({
      result: {
        seed: 'seo tools',
        results: 1,
        keywords: [{ keyword: 'seo software', searchVolume: 1200, difficulty: 40, cpc: 2.5 }],
      },
    });
    const { container } = containerWith(baseStores(), { get });
    const run = await readKeywordResearchRun(container, PROJECT, 'job-1');
    expect(run).toEqual({
      jobId: 'job-1',
      seed: 'seo tools',
      status: 'completed',
      results: 1,
      keywords: [{ keyword: 'seo software', searchVolume: 1200, difficulty: 40, cpc: 2.5 }],
      error: null,
      createdAt: '2026-09-13T10:00:00.000Z',
      completedAt: '2026-09-13T10:00:10.000Z',
    });
  });

  it('caps keyword rows to the run limit', async () => {
    const keywords = Array.from({ length: KEYWORD_RESEARCH_RUN_MAX_KEYWORDS + 25 }, (_, i) => ({
      keyword: `kw-${i}`,
      searchVolume: i,
      difficulty: null,
      cpc: null,
    }));
    const get = jobRecord({ result: { seed: 'seo', results: keywords.length, keywords } });
    const { container } = containerWith(baseStores(), { get });
    const run = await readKeywordResearchRun(container, PROJECT, 'job-1');
    expect(run.keywords).toHaveLength(KEYWORD_RESEARCH_RUN_MAX_KEYWORDS);
  });

  it('shows no keywords until the run completes', async () => {
    const get = jobRecord({ status: 'running', completed_at: null, result: null });
    const { container } = containerWith(baseStores(), { get });
    const run = await readKeywordResearchRun(container, PROJECT, 'job-1');
    expect(run.status).toBe('running');
    expect(run.keywords).toEqual([]);
    expect(run.results).toBe(0);
  });

  it('reports a safe generic error for a failed run, never the raw provider message', async () => {
    const get = jobRecord({
      status: 'failed',
      result: null,
      error: {
        provider: 'dataforseo',
        operation: 'keyword_suggestions',
        message: 'HTTP 500 https://api.dataforseo.com/v3/... key=SECRET',
        http_status: 500,
        code: null,
        retryable: true,
        occurred_at: '2026-09-13T10:00:10.000Z',
      },
    });
    const { container } = containerWith(baseStores(), { get });
    const run = await readKeywordResearchRun(container, PROJECT, 'job-1');
    expect(run.error).toBe('Keyword research failed. Please try again.');
    expect(JSON.stringify(run)).not.toContain('SECRET');
    expect(JSON.stringify(run)).not.toContain('api.dataforseo.com');
  });

  it('does not expose a run that belongs to another project', async () => {
    const get = jobRecord({ project_id: OTHER_PROJECT });
    const { container } = containerWith(baseStores(), { get });
    await expect(readKeywordResearchRun(container, PROJECT, 'job-1')).rejects.toMatchObject({ status: 404 });
  });

  it('does not expose a non-research job', async () => {
    const get = jobRecord({ job_type: 'gsc_sync' });
    const { container } = containerWith(baseStores(), { get });
    await expect(readKeywordResearchRun(container, PROJECT, 'job-1')).rejects.toMatchObject({ status: 404 });
  });
});
