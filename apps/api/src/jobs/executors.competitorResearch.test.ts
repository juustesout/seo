/**
 * competitor_research executor (KW3). One job type, two modes. The executor must
 * stay on the one existing provider/persistence path, cap every run, and carry
 * only bounded normalized results on the job row (never a raw provider blob).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COMPETITOR_RESEARCH_MAX_CANDIDATES,
  COMPETITOR_RESEARCH_MAX_COMPETITORS,
  COMPETITOR_RESEARCH_RUN_MAX_GAPS,
} from '@seo/contracts';
import { getExecutor } from './executors.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

function candidate(domain: string, overrides: Record<string, unknown> = {}) {
  return {
    domain,
    shared_keywords: 10,
    keywords_count: 100,
    avg_position: 5,
    etv: 200,
    ...overrides,
  };
}

function gap(keyword: string, overrides: Record<string, unknown> = {}) {
  return {
    keyword,
    search_volume: 1000,
    difficulty: 30,
    cpc: 1.5,
    competitor_domain: 'rival.com',
    position: 3,
    ...overrides,
  };
}

function build(adapter: {
  discoverCompetitors?: ReturnType<typeof vi.fn>;
  findCompetitorKeywordGaps?: ReturnType<typeof vi.fn>;
}) {
  const persistCompetitorGapKeywords = vi.fn(async () => undefined);
  const persistSourceSnapshot = vi.fn(async () => undefined);
  const container = {
    sb: {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { id: 'ds-1', integration_id: 'int-1', config: {} }, error: null }) }),
          }),
        }),
      }),
    },
    registry: { getDataSource: () => adapter },
    credentials: { reader: () => ({}) },
  } as never;
  return {
    container,
    writer: { persistCompetitorGapKeywords, persistSourceSnapshot } as never,
    persistCompetitorGapKeywords,
    persistSourceSnapshot,
  };
}

describe('competitor_research executor (KW3)', () => {
  it('discover returns bounded normalized candidates without touching the gap store', async () => {
    const discoverCompetitors = vi.fn(async () => [candidate('rival.com')]);
    const { container, writer, persistCompetitorGapKeywords, persistSourceSnapshot } = build({ discoverCompetitors });
    const executor = getExecutor('competitor_research')!;

    const out = await executor({
      container,
      job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: { mode: 'discover', domain: 'example.com' } } as never,
      writer,
      report: vi.fn(),
    });

    expect(discoverCompetitors).toHaveBeenCalledTimes(1);
    expect(persistCompetitorGapKeywords).not.toHaveBeenCalled();
    expect(persistSourceSnapshot).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({
        type: 'competitor_discovery',
        provider: 'dataforseo',
        scope: expect.objectContaining({ domain: 'example.com' }),
        data: expect.objectContaining({ total: 1 }),
      }),
    );
    expect(out).toEqual({
      mode: 'discover',
      domain: 'example.com',
      count: 1,
      competitors: [{ domain: 'rival.com', sharedKeywords: 10, keywordsCount: 100, avgPosition: 5, etv: 200 }],
    });
  });

  it('discover caps the candidate list', async () => {
    const many = Array.from({ length: COMPETITOR_RESEARCH_MAX_CANDIDATES + 5 }, (_, i) => candidate(`rival${i}.com`));
    const discoverCompetitors = vi.fn(async () => many);
    const { container, writer } = build({ discoverCompetitors });
    const executor = getExecutor('competitor_research')!;

    const out = await executor({
      container,
      job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: { mode: 'discover', domain: 'example.com' } } as never,
      writer,
      report: vi.fn(),
    });

    expect((out.competitors as unknown[]).length).toBe(COMPETITOR_RESEARCH_MAX_CANDIDATES);
    expect(out.count).toBe(many.length);
  });

  it('gap pushes provider-side filters, persists the full set and returns bounded rows', async () => {
    const gaps = [gap('blue widgets'), gap('cheap widgets')];
    const findCompetitorKeywordGaps = vi.fn(async () => gaps);
    const { container, writer, persistCompetitorGapKeywords, persistSourceSnapshot } = build({ findCompetitorKeywordGaps });
    const executor = getExecutor('competitor_research')!;

    const out = await executor({
      container,
      job: {
        project_id: PROJECT,
        data_source_id: 'ds-1',
        created_by: 'u1',
        params: { mode: 'gap', domain: 'example.com', competitors: ['rival.com'] },
      } as never,
      writer,
      report: vi.fn(),
    });

    expect(findCompetitorKeywordGaps).toHaveBeenCalledWith(
      expect.anything(),
      'example.com',
      ['rival.com'],
      expect.objectContaining({ minSearchVolume: expect.any(Number), maxRank: expect.any(Number) }),
    );
    expect(persistCompetitorGapKeywords).toHaveBeenCalledWith(PROJECT, gaps);
    expect(persistSourceSnapshot).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({
        type: 'competitor_gap',
        provider: 'dataforseo',
        scope: expect.objectContaining({ domain: 'example.com', competitors: ['rival.com'] }),
        data: expect.objectContaining({ total: 2 }),
      }),
    );
    expect(out).toMatchObject({ mode: 'gap', domain: 'example.com', competitors: ['rival.com'], count: 2 });
    expect((out.gaps as unknown[])[0]).toEqual({
      keyword: 'blue widgets',
      searchVolume: 1000,
      difficulty: 30,
      cpc: 1.5,
      competitorDomain: 'rival.com',
      position: 3,
    });
  });

  it('gap normalizes, de-duplicates and caps competitors before calling the provider', async () => {
    const findCompetitorKeywordGaps = vi.fn(async (_ctx: unknown, _domain: string, _targets: string[]) => []);
    const { container, writer } = build({ findCompetitorKeywordGaps });
    const executor = getExecutor('competitor_research')!;

    await executor({
      container,
      job: {
        project_id: PROJECT,
        data_source_id: 'ds-1',
        created_by: 'u1',
        params: {
          mode: 'gap',
          domain: 'example.com',
          competitors: ['https://WWW.A.com/x', 'a.com', 'b.com', 'c.com', 'd.com'],
        },
      } as never,
      writer,
      report: vi.fn(),
    });

    const targets = findCompetitorKeywordGaps.mock.calls[0][2] as string[];
    expect(targets).toEqual(['a.com', 'b.com', 'c.com']);
    expect(targets.length).toBe(COMPETITOR_RESEARCH_MAX_COMPETITORS);
  });

  it('gap caps the carried result rows', async () => {
    const many = Array.from({ length: COMPETITOR_RESEARCH_RUN_MAX_GAPS + 5 }, (_, i) => gap(`kw-${i}`));
    const findCompetitorKeywordGaps = vi.fn(async () => many);
    const { container, writer } = build({ findCompetitorKeywordGaps });
    const executor = getExecutor('competitor_research')!;

    const out = await executor({
      container,
      job: {
        project_id: PROJECT,
        data_source_id: 'ds-1',
        created_by: 'u1',
        params: { mode: 'gap', domain: 'example.com', competitors: ['rival.com'] },
      } as never,
      writer,
      report: vi.fn(),
    });

    expect((out.gaps as unknown[]).length).toBe(COMPETITOR_RESEARCH_RUN_MAX_GAPS);
    expect(out.count).toBe(many.length);
  });

  it('rejects a gap job with no competitors before touching the provider', async () => {
    const findCompetitorKeywordGaps = vi.fn(async () => []);
    const { container, writer } = build({ findCompetitorKeywordGaps });
    const executor = getExecutor('competitor_research')!;

    await expect(
      executor({
        container,
        job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: { mode: 'gap', domain: 'example.com', competitors: [] } } as never,
        writer,
        report: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(findCompetitorKeywordGaps).not.toHaveBeenCalled();
  });

  it('rejects an unknown mode', async () => {
    const { container, writer } = build({});
    const executor = getExecutor('competitor_research')!;

    await expect(
      executor({
        container,
        job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: { mode: 'nonsense', domain: 'example.com' } } as never,
        writer,
        report: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
