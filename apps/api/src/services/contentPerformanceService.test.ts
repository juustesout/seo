/**
 * ContentPerformanceService tests (P7 measurement loop). Cover the pure path
 * normalization, the publication -> search/traffic join and the honest
 * "no data" states, using a fake Supabase so no network or real DB is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  ContentPerformanceService,
  normalizePathKey,
  resolvePerformancePeriodDays,
} from './contentPerformanceService.js';
import type { ServiceContainer } from '../context.js';

type Row = Record<string, unknown>;

const PROJECT = '11111111-1111-4111-8111-111111111111';

function makeSb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let limit: number | null = null;
      const rows = () => tables[table] ?? [];
      const apply = () => {
        let r = rows().filter((x) => filters.every((f) => f(x)));
        if (limit !== null) r = r.slice(0, limit);
        return r;
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: unknown) => {
          filters.push((r) => r[c] === v);
          return builder;
        },
        is: (c: string, v: unknown) => {
          filters.push((r) => r[c] === v);
          return builder;
        },
        not: (c: string, _op: string, v: unknown) => {
          filters.push((r) => r[c] !== v);
          return builder;
        },
        in: (c: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[c]));
          return builder;
        },
        gte: (c: string, v: unknown) => {
          filters.push((r) => String(r[c]) >= String(v));
          return builder;
        },
        lte: (c: string, v: unknown) => {
          filters.push((r) => String(r[c]) <= String(v));
          return builder;
        },
        order: () => builder,
        limit: (n: number) => {
          limit = n;
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: apply(), error: null }),
      };
      return builder;
    },
  };
}

function makeContainer(tables: Record<string, Row[]>): ServiceContainer {
  return { sb: makeSb(tables) } as unknown as ServiceContainer;
}

const NOW = () => new Date('2026-09-13T12:00:00Z');

function baseTables(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    seo_publications: [
      {
        project_id: PROJECT,
        content_id: 'c1',
        target_url: 'https://example.com/blog/seo-guide',
        status: 'published',
        published_at: '2026-09-02T00:00:00Z',
        created_at: '2026-09-02T00:00:00Z',
      },
    ],
    seo_content: [
      {
        project_id: PROJECT,
        id: 'c1',
        title: 'SEO Guide',
        url: 'https://example.com/blog/seo-guide',
        slug: 'blog/seo-guide',
        status: 'published',
        target_keyword: 'seo guide',
        published_at: '2026-09-01T00:00:00Z',
      },
    ],
    seo_project_properties: [{ project_id: PROJECT, property_id: 'p1' }],
    seo_project_analytics: [
      { project_id: PROJECT, property_id: '123', property_name: 'Site', property_url: 'https://example.com' },
    ],
    seo_gsc_pages: [
      { project_id: PROJECT, url: 'https://example.com/blog/seo-guide', clicks: 100, impressions: 1000, position: 5, date: '2026-09-10' },
      { project_id: PROJECT, url: 'https://example.com/blog/seo-guide/', clicks: 50, impressions: 500, position: 7, date: '2026-09-11' },
      { project_id: PROJECT, url: 'https://example.com/unrelated', clicks: 10, impressions: 10, position: 3, date: '2026-09-10' },
    ],
    seo_page_traffic: [
      { project_id: PROJECT, path: '/blog/seo-guide', views: 300, active_users: 250, sessions: 280, date: '2026-09-10', fetched_at: '2026-09-12T00:00:00Z' },
    ],
    ...overrides,
  };
}

describe('normalizePathKey', () => {
  it('reduces URLs and paths to one comparable key', () => {
    expect(normalizePathKey('https://example.com/blog/seo-guide/')).toBe('/blog/seo-guide');
    expect(normalizePathKey('/blog/seo-guide')).toBe('/blog/seo-guide');
    expect(normalizePathKey('blog/SEO-Guide')).toBe('/blog/seo-guide');
    expect(normalizePathKey('https://example.com/?utm=x#frag')).toBe('/');
  });

  it('returns null for empty or unparsable values', () => {
    expect(normalizePathKey('')).toBeNull();
    expect(normalizePathKey(null)).toBeNull();
    expect(normalizePathKey('   ')).toBeNull();
  });
});

describe('resolvePerformancePeriodDays', () => {
  it('accepts only the supported periods and defaults to 28', () => {
    expect(resolvePerformancePeriodDays('7')).toBe(7);
    expect(resolvePerformancePeriodDays(90)).toBe(90);
    expect(resolvePerformancePeriodDays('365')).toBe(28);
    expect(resolvePerformancePeriodDays(undefined)).toBe(28);
  });
});

describe('ContentPerformanceService.report', () => {
  it('joins published content with Search Console and GA4 metrics', async () => {
    const svc = new ContentPerformanceService(makeContainer(baseTables()), NOW);
    const report = await svc.report(PROJECT, 28);

    expect(report.sources).toEqual({ gsc: true, ga4: true });
    expect(report.period).toEqual({ days: 28, start_date: '2026-08-17', end_date: '2026-09-13' });
    expect(report.rows).toHaveLength(1);

    const row = report.rows[0]!;
    expect(row.content_id).toBe('c1');
    expect(row.publication_url).toBe('https://example.com/blog/seo-guide');
    expect(row.published_at).toBe('2026-09-02T00:00:00Z');
    expect(row.days_live).toBe(11);
    expect(row.state).toBe('measured');
    expect(row.matched_path).toBe('/blog/seo-guide');
    expect(row.search?.clicks).toBe(150);
    expect(row.search?.impressions).toBe(1500);
    expect(row.search?.position).toBeCloseTo(5.67, 2);
    expect(row.search?.ctr).toBeCloseTo(0.1, 4);
    expect(row.traffic).toEqual({ views: 300, active_users: 250, sessions: 280 });

    expect(report.totals.search?.clicks).toBe(150);
    expect(report.totals.traffic?.views).toBe(300);
    expect(report.last_synced_at).toBe('2026-09-12T00:00:00Z');
  });

  it('reports published content with no matched data honestly and notes missing providers', async () => {
    const svc = new ContentPerformanceService(
      makeContainer(
        baseTables({
          seo_publications: [],
          seo_project_properties: [],
          seo_project_analytics: [],
          seo_gsc_pages: [],
          seo_page_traffic: [],
        }),
      ),
      NOW,
    );
    const report = await svc.report(PROJECT, 28);

    expect(report.sources).toEqual({ gsc: false, ga4: false });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.state).toBe('no_traffic');
    expect(row.search).toBeNull();
    expect(row.traffic).toBeNull();
    expect(row.publication_url).toBeNull();
    expect(row.days_live).toBe(12);
    expect(report.totals).toEqual({ search: null, traffic: null });
    expect(report.notes).toHaveLength(2);
  });
});
