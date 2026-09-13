/**
 * dataforseo_keyword_research executor (KW2). The executor must stay on the one
 * existing provider/persistence path and additionally carry the run's own
 * bounded, normalized results on the job row so the UI can read exactly the run
 * it started - never a raw provider blob.
 */
import { describe, expect, it, vi } from 'vitest';
import { KEYWORD_RESEARCH_RUN_MAX_KEYWORDS } from '@seo/contracts';
import { getExecutor } from './executors.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

function result(overrides: Record<string, unknown> = {}) {
  return {
    keyword: 'seo software',
    location_code: 2840,
    language_code: 'en',
    search_volume: 1200,
    cpc: 2.5,
    competition: 'HIGH',
    difficulty: 40,
    serp: [],
    keyword_intents: ['commercial'],
    ...overrides,
  };
}

function build(adapter: { researchKeywords: ReturnType<typeof vi.fn> }) {
  const persistKeywordResearch = vi.fn(async () => undefined);
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
  return { container, writer: { persistKeywordResearch } as never, persistKeywordResearch };
}

describe('dataforseo_keyword_research executor (KW2)', () => {
  it('persists through the existing writer and returns bounded normalized results', async () => {
    const researchKeywords = vi.fn(async () => [result()]);
    const { container, writer, persistKeywordResearch } = build({ researchKeywords });
    const executor = getExecutor('dataforseo_keyword_research')!;

    const out = await executor({
      container,
      job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: { seeds: ['seo'] } } as never,
      writer,
      report: vi.fn(),
    });

    expect(researchKeywords).toHaveBeenCalledTimes(1);
    expect(persistKeywordResearch).toHaveBeenCalledWith(PROJECT, expect.any(Array));
    expect(out).toEqual({
      seed: 'seo',
      seeds: 1,
      results: 1,
      keywords: [{ keyword: 'seo software', searchVolume: 1200, difficulty: 40, cpc: 2.5 }],
    });
  });

  it('maps unreported metrics to null, never fabricated zeros', async () => {
    const researchKeywords = vi.fn(async () => [result({ search_volume: null, difficulty: null, cpc: null })]);
    const { container, writer } = build({ researchKeywords });
    const executor = getExecutor('dataforseo_keyword_research')!;

    const out = await executor({
      container,
      job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: { seeds: ['seo'] } } as never,
      writer,
      report: vi.fn(),
    });

    expect((out.keywords as unknown[])[0]).toEqual({
      keyword: 'seo software',
      searchVolume: null,
      difficulty: null,
      cpc: null,
    });
  });

  it('caps the run result rows without touching the full persistence set', async () => {
    const many = Array.from({ length: KEYWORD_RESEARCH_RUN_MAX_KEYWORDS + 10 }, (_, i) => result({ keyword: `kw-${i}` }));
    const researchKeywords = vi.fn(async () => many);
    const { container, writer, persistKeywordResearch } = build({ researchKeywords });
    const executor = getExecutor('dataforseo_keyword_research')!;

    const out = await executor({
      container,
      job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: { seeds: ['seo'] } } as never,
      writer,
      report: vi.fn(),
    });

    expect((out.keywords as unknown[]).length).toBe(KEYWORD_RESEARCH_RUN_MAX_KEYWORDS);
    expect(out.results).toBe(many.length);
    expect(persistKeywordResearch).toHaveBeenCalledWith(PROJECT, many);
  });

  it('rejects a job with no seeds before touching the provider', async () => {
    const researchKeywords = vi.fn(async () => [result()]);
    const { container, writer } = build({ researchKeywords });
    const executor = getExecutor('dataforseo_keyword_research')!;

    await expect(
      executor({
        container,
        job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: {} } as never,
        writer,
        report: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(researchKeywords).not.toHaveBeenCalled();
  });
});
