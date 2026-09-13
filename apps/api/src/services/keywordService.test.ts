/**
 * Keyword service tests (KW1).
 *
 * Covers the two things that must not drift: the deterministic roll-up math
 * (period sums, click-through rate, impression-weighted position - never an
 * average of averages) and project/property scoping of the read. The fake
 * Supabase client actually applies the filters and pagination the service
 * issues, so an isolation regression fails here rather than in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../context.js';
import { KeywordService, aggregateGscKeywords, resolveKeywordRange } from './keywordService.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

/** Minimal Supabase-like client that honours eq/gte/lte/order/limit/range. */
function fakeSb(getStores: () => Store) {
  return {
    from(table: string) {
      const all = getStores()[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN: number | null = null;
      let rangeFrom: number | null = null;
      let rangeTo: number | null = null;

      const apply = (): Row[] => {
        let rows = all.filter((r) => filters.every((f) => f(r)));
        if (orderCol) {
          const col = orderCol;
          rows = [...rows].sort((a, b) => {
            const av = a[col] as string | number;
            const bv = b[col] as string | number;
            if (av === bv) return 0;
            return (av > bv ? 1 : -1) * (orderAsc ? 1 : -1);
          });
        }
        if (rangeFrom !== null && rangeTo !== null) rows = rows.slice(rangeFrom, rangeTo + 1);
        else if (limitN !== null) rows = rows.slice(0, limitN);
        return rows;
      };

      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        gte: (col: string, val: unknown) => {
          filters.push((r) => String(r[col]) >= String(val));
          return builder;
        },
        lte: (col: string, val: unknown) => {
          filters.push((r) => String(r[col]) <= String(val));
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return builder;
        },
        limit: (n: number) => {
          limitN = n;
          return builder;
        },
        range: (from: number, to: number) => {
          rangeFrom = from;
          rangeTo = to;
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: apply(), error: null }),
      };
      return builder;
    },
  };
}

function container(getStores: () => Store): ServiceContainer {
  return { config: { env: {} }, registry: {}, sb: fakeSb(getStores), jobStore: {} } as unknown as ServiceContainer;
}

const PROJECT = 'project-1';
const PROPERTY = 'property-1';
const OTHER_PROPERTY = 'property-2';
const RANGE = { startDate: '2026-08-17', endDate: '2026-09-13', limit: 100 };

function queryRow(overrides: Row = {}): Row {
  return {
    project_id: PROJECT,
    property_id: PROPERTY,
    query: 'seo',
    clicks: 1,
    impressions: 10,
    position: 5,
    date: '2026-09-01',
    ...overrides,
  };
}

function storesWith(rows: Row[], links: Row[] = [{ project_id: PROJECT, property_id: PROPERTY, is_primary: true, created_at: '2026-01-01' }]): Store {
  return {
    seo_project_properties: links,
    seo_gsc_queries: rows,
    seo_data_sources: [{ project_id: PROJECT, provider_type: 'gsc', last_synced_at: '2026-09-12T08:00:00.000Z' }],
  };
}

describe('aggregateGscKeywords', () => {
  it('sums the period and recomputes ctr + impression-weighted position across days', () => {
    const out = aggregateGscKeywords([
      { query: 'seo tools', clicks: 5, impressions: 100, position: 4 },
      { query: 'seo tools', clicks: 3, impressions: 300, position: 8 },
      { query: 'rank tracker', clicks: 2, impressions: 50, position: 2 },
    ]);
    const seo = out.find((k) => k.keyword === 'seo tools')!;
    expect(seo.clicks).toBe(8);
    expect(seo.impressions).toBe(400);
    expect(seo.ctr).toBe(0.02);
    expect(seo.position).toBe(7);
  });

  it('orders by impressions desc, then clicks desc, then keyword asc', () => {
    const out = aggregateGscKeywords([
      { query: 'b', clicks: 1, impressions: 10, position: 1 },
      { query: 'a', clicks: 1, impressions: 10, position: 1 },
      { query: 'c', clicks: 2, impressions: 10, position: 1 },
      { query: 'high', clicks: 0, impressions: 100, position: 1 },
    ]);
    expect(out.map((k) => k.keyword)).toEqual(['high', 'c', 'a', 'b']);
  });

  it('yields zero ctr/position without impressions and skips blank queries', () => {
    const out = aggregateGscKeywords([
      { query: 'zero', clicks: 0, impressions: 0, position: 5 },
      { query: '   ', clicks: 9, impressions: 9, position: 1 },
    ]);
    expect(out).toEqual([{ keyword: 'zero', clicks: 0, impressions: 0, ctr: 0, position: 0 }]);
  });
});

describe('resolveKeywordRange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('defaults to the 28 days ending today with the default limit', () => {
    expect(resolveKeywordRange({})).toEqual({ startDate: '2026-08-17', endDate: '2026-09-13', limit: 100 });
  });

  it('honours an explicit range and limit', () => {
    expect(resolveKeywordRange({ startDate: '2026-01-01', endDate: '2026-01-31', limit: '25' })).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      limit: 25,
    });
  });

  it('rejects a malformed calendar date', () => {
    expect(() => resolveKeywordRange({ startDate: '2026-02-30' })).toThrow(/Invalid keyword query parameters/);
  });

  it('rejects a reversed range', () => {
    expect(() => resolveKeywordRange({ startDate: '2026-05-01', endDate: '2026-04-01' })).toThrow(
      /startDate must be on or before endDate/,
    );
  });

  it('rejects an unbounded range and an out-of-bounds limit', () => {
    expect(() => resolveKeywordRange({ startDate: '2000-01-01', endDate: '2026-01-01' })).toThrow(
      /Date range must be/,
    );
    expect(() => resolveKeywordRange({ limit: 5000 })).toThrow(/Invalid keyword query parameters/);
    expect(() => resolveKeywordRange({ limit: 0 })).toThrow(/Invalid keyword query parameters/);
  });
});

describe('KeywordService.listProjectKeywords', () => {
  it('reports no property when the project has not linked one', async () => {
    const stores = storesWith([queryRow()], []);
    const svc = new KeywordService(container(() => stores));
    await expect(svc.listProjectKeywords(PROJECT, RANGE)).resolves.toEqual({
      propertyId: null,
      lastSyncedAt: null,
      keywords: [],
    });
  });

  it('aggregates only the linked property rows of this project', async () => {
    const stores = storesWith([
      queryRow({ query: 'mine', clicks: 4, impressions: 100, position: 3, date: '2026-09-02' }),
      queryRow({ query: 'mine', clicks: 1, impressions: 100, position: 6, date: '2026-09-03' }),
      // another project / property in the same table must never leak in
      queryRow({ query: 'other-project', project_id: 'project-2', clicks: 99, impressions: 9999 }),
      queryRow({ query: 'other-property', property_id: OTHER_PROPERTY, clicks: 99, impressions: 9999 }),
      // outside the requested window
      queryRow({ query: 'old', clicks: 99, impressions: 9999, date: '2026-01-01' }),
    ]);
    const svc = new KeywordService(container(() => stores));
    const out = await svc.listProjectKeywords(PROJECT, RANGE);

    expect(out.propertyId).toBe(PROPERTY);
    expect(out.lastSyncedAt).toBe('2026-09-12T08:00:00.000Z');
    expect(out.keywords).toEqual([
      { keyword: 'mine', clicks: 5, impressions: 200, ctr: 0.025, position: 4.5 },
    ]);
  });

  it('returns the property with no keywords when it has never synced rows', async () => {
    const stores = storesWith([]);
    const svc = new KeywordService(container(() => stores));
    const out = await svc.listProjectKeywords(PROJECT, RANGE);
    expect(out.propertyId).toBe(PROPERTY);
    expect(out.keywords).toEqual([]);
  });

  it('scans past a single response page and applies the result limit', async () => {
    const rows: Row[] = Array.from({ length: 1500 }, () => queryRow({ query: 'bulk', impressions: 1, clicks: 0 }));
    const stores = storesWith(rows);
    const svc = new KeywordService(container(() => stores));
    const out = await svc.listProjectKeywords(PROJECT, { ...RANGE, limit: 10 });
    expect(out.keywords).toEqual([{ keyword: 'bulk', clicks: 0, impressions: 1500, ctr: 0, position: 5 }]);
  });
});
