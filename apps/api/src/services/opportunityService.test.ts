/**
 * Opportunity service tests (KW5). They prove the pipeline is a pure read over
 * the current-best-known gap snapshot: consolidation merges spelling variants
 * without losing provenance, the bounded query filters/orders/sorts rows, and
 * a missing or foreign-project snapshot yields no opportunities.
 */
import { describe, expect, it } from 'vitest';
import type { CompetitorGapDto } from '@seo/contracts';
import { buildOpportunities, getOpportunities } from './opportunityService.js';
import { competitorGapScope, scopeKeyOf } from './sourceScope.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';

function gap(overrides: Partial<CompetitorGapDto> & { keyword: string }): CompetitorGapDto {
  return {
    searchVolume: 1000,
    difficulty: 40,
    cpc: 1.5,
    competitorDomain: 'rival.com',
    position: 3,
    ...overrides,
  };
}

function snapshotRow(
  projectId: string,
  fetchedAt: string,
  gaps: CompetitorGapDto[],
  competitors: string[] = ['rival.com'],
  domain = 'example.com',
  id = 'snap-1',
) {
  const scope = competitorGapScope({ domain, competitors });
  return {
    id,
    project_id: projectId,
    type: 'competitor_gap',
    provider: 'dataforseo',
    scope,
    scope_key: scopeKeyOf(scope),
    data: { gaps, total: gaps.length },
    fetched_at: fetchedAt,
    source_job_id: null,
  };
}

function fakeSb(rows: Record<string, unknown>[]) {
  return {
    from() {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const orders: Array<{ col: string; asc: boolean }> = [];
      let limitN = Number.POSITIVE_INFINITY;
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orders.push({ col, asc: opts?.ascending !== false });
          return builder;
        },
        limit: (n: number) => {
          limitN = n;
          return builder;
        },
        maybeSingle: async () => {
          let out = rows.filter((r) => filters.every((f) => f(r)));
          for (const { col, asc } of [...orders].reverse()) {
            out = [...out].sort((a, b) => {
              const av = a[col] as string;
              const bv = b[col] as string;
              if (av === bv) return 0;
              return (av < bv ? -1 : 1) * (asc ? 1 : -1);
            });
          }
          return { data: out.slice(0, limitN)[0] ?? null, error: null };
        },
      };
      return builder;
    },
  };
}

function containerWith(rows: Record<string, unknown>[]) {
  return { sb: fakeSb(rows) } as never;
}

const NOW = new Date('2026-09-14T12:00:00.000Z');
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

describe('buildOpportunities', () => {
  it('consolidates spelling variants into one row and preserves provenance', () => {
    const rows = buildOpportunities([
      gap({ keyword: 'front end newsletter', competitorDomain: 'a.com', position: 3 }),
      gap({ keyword: 'front-end newsletter', competitorDomain: 'b.com', position: 7 }),
      gap({ keyword: 'frontend newsletter', competitorDomain: 'c.com', position: 9 }),
    ]);
    expect(rows).toHaveLength(1);
    const opportunity = rows[0]!;
    expect(opportunity.competitorCount).toBe(3);
    expect(opportunity.variants).toEqual(['front end newsletter', 'front-end newsletter', 'frontend newsletter']);
    expect(opportunity.competitors.map((c) => c.domain)).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('keeps each competitor once with its best rank', () => {
    const rows = buildOpportunities([
      gap({ keyword: 'blue widgets', competitorDomain: 'rival.com', position: 8 }),
      gap({ keyword: 'blue widgets', competitorDomain: 'rival.com', position: 2 }),
    ]);
    expect(rows[0]!.competitors).toEqual([{ domain: 'rival.com', rank: 2 }]);
    expect(rows[0]!.competitorCount).toBe(1);
  });

  it('never fabricates a missing metric', () => {
    const rows = buildOpportunities([
      gap({ keyword: 'thin data', searchVolume: null, difficulty: null, cpc: null, competitorDomain: '', position: null }),
    ]);
    expect(rows[0]!.searchVolume).toBeNull();
    expect(rows[0]!.difficulty).toBeNull();
    expect(rows[0]!.cpc).toBeNull();
    expect(rows[0]!.competitors).toEqual([]);
    expect(rows[0]!.reasons).toEqual([]);
  });

  it('is deterministic for identical input', () => {
    const input = [gap({ keyword: 'blue widgets' }), gap({ keyword: 'blue-widgets' })];
    expect(buildOpportunities(input)).toEqual(buildOpportunities(input));
  });
});

describe('getOpportunities', () => {
  const set = ['rival.com'];

  it('returns an empty result when no gap snapshot exists for the set', async () => {
    const result = await getOpportunities(containerWith([]), PROJECT, set, {}, 'example.com');
    expect(result.snapshot).toBeNull();
    expect(result.opportunities).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('reads the exact-set snapshot and echoes its domain and competitors', async () => {
    // Freshness is derived against the wall clock, so this fixture is anchored to
    // now; a hardcoded date would silently expire once it aged past the fresh window.
    const fetchedAt = new Date().toISOString();
    const container = containerWith([snapshotRow(PROJECT, fetchedAt, [gap({ keyword: 'blue widgets' })])]);
    const result = await getOpportunities(container, PROJECT, set, {}, 'example.com');
    expect(result.snapshot?.freshness.state).toBe('fresh');
    expect(result.snapshot?.domain).toBe('example.com');
    expect(result.snapshot?.competitors).toEqual(['rival.com']);
    expect(result.opportunities).toHaveLength(1);
  });

  it('reads the requested set, not the newest snapshot for the project', async () => {
    const container = containerWith([
      snapshotRow(PROJECT, iso(1), [gap({ keyword: 'from set A' })], ['rival.com'], 'example.com', 'snap-a'),
      snapshotRow(PROJECT, iso(0), [gap({ keyword: 'from set B' })], ['other.com'], 'example.com', 'snap-b'),
    ]);
    const result = await getOpportunities(container, PROJECT, ['rival.com'], {}, 'example.com');
    expect(result.opportunities.map((o) => o.keyword)).toEqual(['from set A']);
    expect(result.snapshot?.id).toBe('snap-a');
  });

  it('reports a stale snapshot without hiding it', async () => {
    const container = containerWith([snapshotRow(PROJECT, iso(40), [gap({ keyword: 'blue widgets' })])]);
    const result = await getOpportunities(container, PROJECT, set, {}, 'example.com');
    expect(result.snapshot?.freshness.state).toBe('stale');
    expect(result.opportunities).toHaveLength(1);
  });

  it('never returns a snapshot from another project', async () => {
    const container = containerWith([snapshotRow(OTHER_PROJECT, NOW.toISOString(), [gap({ keyword: 'blue widgets' })])]);
    const result = await getOpportunities(container, PROJECT, set, {}, 'example.com');
    expect(result.snapshot).toBeNull();
    expect(result.opportunities).toEqual([]);
  });

  it('applies result-view filters and keeps metric nulls out', async () => {
    const container = containerWith([
      snapshotRow(PROJECT, NOW.toISOString(), [
        gap({ keyword: 'low volume', searchVolume: 50, difficulty: 30 }),
        gap({ keyword: 'high volume', searchVolume: 5000, difficulty: 30 }),
        gap({ keyword: 'unknown volume', searchVolume: null, difficulty: 30 }),
      ]),
    ]);
    const result = await getOpportunities(container, PROJECT, set, { minVolume: 100 }, 'example.com');
    expect(result.opportunities.map((o) => o.keyword).sort()).toEqual(['high volume']);
  });

  it('filters by derived intent', async () => {
    const container = containerWith([
      snapshotRow(PROJECT, NOW.toISOString(), [
        gap({ keyword: 'buy blue widgets' }),
        gap({ keyword: 'frontend newsletter' }),
      ]),
    ]);
    const result = await getOpportunities(container, PROJECT, set, { intent: 'transactional' }, 'example.com');
    expect(result.opportunities.map((o) => o.keyword)).toEqual(['buy blue widgets']);
  });

  it('sorts by score descending by default and bounds the limit', async () => {
    const container = containerWith([
      snapshotRow(PROJECT, NOW.toISOString(), [
        gap({ keyword: 'weak', searchVolume: 20, difficulty: 90, cpc: null }),
        gap({ keyword: 'strong', searchVolume: 50_000, difficulty: 10, cpc: 8 }),
        gap({ keyword: 'medium', searchVolume: 1000, difficulty: 50, cpc: 1 }),
      ]),
    ]);
    const result = await getOpportunities(container, PROJECT, set, { limit: 2 }, 'example.com');
    expect(result.opportunities.map((o) => o.keyword)).toEqual(['strong', 'medium']);
    expect(result.total).toBe(3);
    expect(result.count).toBe(2);
  });

  it('sorts by keyword ascending when asked', async () => {
    const container = containerWith([
      snapshotRow(PROJECT, NOW.toISOString(), [gap({ keyword: 'zebra' }), gap({ keyword: 'alpha' })]),
    ]);
    const result = await getOpportunities(container, PROJECT, set, { sort: 'keyword', dir: 'asc' }, 'example.com');
    expect(result.opportunities.map((o) => o.keyword)).toEqual(['alpha', 'zebra']);
  });
});
