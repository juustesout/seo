/**
 * dataforseo_keyword_research executor, KW4 expansion branch.
 *
 * The single most important boundary in KW4: the executor must branch on the
 * *presence* of `params.methods`. Absent -> the exact legacy KW2
 * research-and-add path (auto-persisted, legacy result shape). Present -> a KW4
 * expansion snapshot that is NOT auto-persisted and carries per-method status.
 * Partial method failure must not fail the run; total failure must.
 */
import { describe, expect, it, vi } from 'vitest';
import { getExecutor } from './executors.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

function result(keyword: string, overrides: Record<string, unknown> = {}) {
  return {
    keyword,
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

function build(adapter: Record<string, ReturnType<typeof vi.fn>>) {
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

function executor() {
  return getExecutor('dataforseo_keyword_research')!;
}

describe('dataforseo_keyword_research executor (KW4 discriminator)', () => {
  it('runs the exact legacy KW2 path when methods is absent', async () => {
    const researchKeywords = vi.fn(async () => [result('seo software')]);
    const relatedKeywords = vi.fn(async () => [result('x')]);
    const keywordIdeas = vi.fn(async () => [result('y')]);
    const { container, writer, persistKeywordResearch } = build({ researchKeywords, relatedKeywords, keywordIdeas });

    const out = await executor()({
      container,
      job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: { seeds: ['seo'] } } as never,
      writer,
      report: vi.fn(),
    });

    // Legacy: researchKeywords called with NO opts, and results auto-persisted.
    expect(researchKeywords).toHaveBeenCalledTimes(1);
    expect(researchKeywords.mock.calls[0]).toHaveLength(2);
    expect(persistKeywordResearch).toHaveBeenCalledWith(PROJECT, expect.any(Array));
    expect(out).toEqual({
      seed: 'seo',
      seeds: 1,
      results: 1,
      keywords: [{ keyword: 'seo software', searchVolume: 1200, difficulty: 40, cpc: 2.5 }],
    });
    expect(out).not.toHaveProperty('methodStatus');
  });

  it("uses the snapshot path for methods:['suggestions'] and never auto-persists", async () => {
    const researchKeywords = vi.fn(async () => [result('seo software')]);
    const { container, writer, persistKeywordResearch } = build({
      researchKeywords,
      relatedKeywords: vi.fn(),
      keywordIdeas: vi.fn(),
    });

    const out = await executor()({
      container,
      job: {
        project_id: PROJECT,
        data_source_id: 'ds-1',
        created_by: 'u1',
        params: { seeds: ['seo'], methods: ['suggestions'], relatedDepth: 1, limitPerMethod: 200, providerMinVolume: 50 },
      } as never,
      writer,
      report: vi.fn(),
    });

    // Expansion: researchKeywords receives KW4 opts; nothing is auto-persisted.
    expect(researchKeywords).toHaveBeenCalledTimes(1);
    expect(researchKeywords).toHaveBeenCalledWith(expect.anything(), ['seo'], { limit: 200, minSearchVolume: 50 });
    expect(persistKeywordResearch).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      seeds: ['seo'],
      methods: ['suggestions'],
      methodStatus: { suggestions: { status: 'success', count: 1 } },
      count: 1,
      candidates: [
        { keyword: 'seo software', searchVolume: 1200, difficulty: 40, cpc: 2.5, methods: ['suggestions'], seeds: ['seo'] },
      ],
    });
    expect(out).not.toHaveProperty('keywords');
  });

  it('keeps usable rows from other methods when one method fails', async () => {
    const researchKeywords = vi.fn(async () => [result('suggested')]);
    const relatedKeywords = vi.fn(async () => {
      throw new Error('related boom');
    });
    const keywordIdeas = vi.fn(async () => [result('idea')]);
    const { container, writer, persistKeywordResearch } = build({ researchKeywords, relatedKeywords, keywordIdeas });

    const out = await executor()({
      container,
      job: {
        project_id: PROJECT,
        data_source_id: 'ds-1',
        created_by: 'u1',
        params: { seeds: ['seo'], methods: ['suggestions', 'related', 'ideas'], relatedDepth: 2, limitPerMethod: 100 },
      } as never,
      writer,
      report: vi.fn(),
    });

    expect(out).toMatchObject({ methodStatus: { related: { status: 'failed', count: 0 } } });
    const candidates = out.candidates as Array<{ keyword: string }>;
    expect(candidates.map((c) => c.keyword).sort()).toEqual(['idea', 'suggested']);
    expect(persistKeywordResearch).not.toHaveBeenCalled();
    // related depth + per-method cap are pushed to the adapter
    expect(relatedKeywords).toHaveBeenCalledWith(expect.anything(), 'seo', { depth: 2, limit: 100, minSearchVolume: undefined });
  });

  it('fails the run only when every requested method fails', async () => {
    const boom = vi.fn(async () => {
      throw new Error('provider down');
    });
    const { container, writer, persistKeywordResearch } = build({ researchKeywords: boom, relatedKeywords: boom, keywordIdeas: boom });

    await expect(
      executor()({
        container,
        job: {
          project_id: PROJECT,
          data_source_id: 'ds-1',
          created_by: 'u1',
          params: { seeds: ['seo'], methods: ['suggestions', 'ideas'] },
        } as never,
        writer,
        report: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(persistKeywordResearch).not.toHaveBeenCalled();
  });
});
