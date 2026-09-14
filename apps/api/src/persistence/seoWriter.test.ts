/**
 * seoWriter competitor-gap persistence tests (KW5.1).
 *
 * The `seo_keywords` unique key omits the competitor, so the same keyword found
 * for several competitors must collapse to one row before the upsert. These
 * tests prove the deterministic dedupe rule, the provenance it keeps, and that
 * the writer sends a batch the database can accept.
 */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CompetitorKeywordGap } from '@seo/contracts';
import { dedupeGapKeywords, SeoWriter } from './seoWriter.js';

function gap(overrides: Partial<CompetitorKeywordGap> & { keyword: string }): CompetitorKeywordGap {
  return {
    search_volume: 1000,
    difficulty: 30,
    cpc: 1.5,
    competitor_domain: 'a.com',
    position: 3,
    ...overrides,
  };
}

describe('dedupeGapKeywords', () => {
  it('collapses the same keyword across competitors onto one persistence row', () => {
    const out = dedupeGapKeywords([
      gap({ keyword: 'wordpress development', competitor_domain: 'a.com', search_volume: 500, cpc: 1 }),
      gap({ keyword: 'wordpress development', competitor_domain: 'b.com', search_volume: 900, difficulty: 20, cpc: 2.5 }),
    ]);
    expect(out).toEqual([
      { keyword: 'wordpress development', volume: 900, difficulty: 30, cpc: 2.5, competitorDomains: ['a.com', 'b.com'] },
    ]);
  });

  it('keeps distinct keywords, sorts domains and is deterministic', () => {
    const input = [
      gap({ keyword: 'b', competitor_domain: 'z.com' }),
      gap({ keyword: 'a', competitor_domain: 'z.com' }),
      gap({ keyword: 'b', competitor_domain: 'a.com' }),
    ];
    const out = dedupeGapKeywords(input);
    expect(out.map((r) => r.keyword)).toEqual(['a', 'b']);
    expect(out[1]!.competitorDomains).toEqual(['a.com', 'z.com']);
    expect(dedupeGapKeywords(input)).toEqual(out);
  });

  it('never fabricates a missing metric or a blank domain', () => {
    const out = dedupeGapKeywords([
      gap({ keyword: 'thin', search_volume: null, difficulty: null, cpc: null, competitor_domain: '' }),
    ]);
    expect(out[0]).toMatchObject({ volume: null, difficulty: null, cpc: null, competitorDomains: [] });
  });
});

describe('SeoWriter.persistCompetitorGapKeywords', () => {
  it('upserts one row per keyword with every contributing competitor in provenance', async () => {
    const upserted: Array<Record<string, unknown>[]> = [];
    const sb = {
      from: () => ({
        upsert: (rows: Record<string, unknown>[]) => {
          upserted.push(rows);
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;

    await new SeoWriter(sb).persistCompetitorGapKeywords('p-1', [
      gap({ keyword: 'wordpress development', competitor_domain: 'a.com' }),
      gap({ keyword: 'wordpress development', competitor_domain: 'b.com' }),
      gap({ keyword: 'wordpress revisions', competitor_domain: 'a.com' }),
    ]);

    expect(upserted).toHaveLength(1);
    const rows = upserted[0]!;
    expect(rows).toHaveLength(2);
    const development = rows.find((r) => r.keyword === 'wordpress development')!;
    expect(development).toMatchObject({ project_id: 'p-1', source: 'competitor_gap', provider: 'dataforseo', volume: 1000 });
    expect(development.meta).toEqual({
      discovered_via: 'competitor_gap',
      gap_type: 'competitor_only',
      competitor_domains: ['a.com', 'b.com'],
      competitor_count: 2,
    });
  });
});
