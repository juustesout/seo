import { describe, expect, it } from 'vitest';
import type { ServiceContainer } from '../context.js';
import { ContentIntelligenceService } from './contentIntelligenceService.js';

/**
 * Regression coverage for P8-A: GSC content intelligence resolves a project's
 * property through the canonical account-scoped relationship
 * (`seo_project_properties` -> `seo_gsc_properties`), not the dropped
 * `seo_gsc_properties.project_id` column. The fake client here applies the
 * query filters (the shared test fake ignores them), which is what makes the
 * project-isolation assertions meaningful.
 */

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

type Op = 'eq' | 'neq' | 'in' | 'is' | 'ilike' | 'gte' | 'lte';
interface Filter {
  col: string;
  op: Op;
  val: unknown;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col];
  switch (f.op) {
    case 'eq':
      return String(v) === String(f.val);
    case 'neq':
      return String(v) !== String(f.val);
    case 'in':
      return (f.val as unknown[]).some((x) => String(x) === String(v));
    case 'is':
      return f.val === null ? v === null || v === undefined : v === f.val;
    case 'ilike':
      return String(v ?? '').toLowerCase().includes(String(f.val).toLowerCase());
    case 'gte':
      return String(v) >= String(f.val);
    case 'lte':
      return String(v) <= String(f.val);
    default:
      return true;
  }
}

/** Minimal filter-aware Supabase-like client. */
function filterSb(stores: Store) {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      let take: number | null = null;
      const b = {} as Record<string, unknown>;
      const chain = () => b;
      b.select = chain;
      b.order = chain;
      b.range = chain;
      b.eq = (col: string, val: unknown) => (filters.push({ col, op: 'eq', val }), b);
      b.neq = (col: string, val: unknown) => (filters.push({ col, op: 'neq', val }), b);
      b.in = (col: string, val: unknown[]) => (filters.push({ col, op: 'in', val }), b);
      b.is = (col: string, val: unknown) => (filters.push({ col, op: 'is', val }), b);
      b.ilike = (col: string, val: unknown) => (filters.push({ col, op: 'ilike', val }), b);
      b.gte = (col: string, val: unknown) => (filters.push({ col, op: 'gte', val }), b);
      b.lte = (col: string, val: unknown) => (filters.push({ col, op: 'lte', val }), b);
      b.limit = (n: number) => ((take = n), b);
      const resolve = () => {
        let rows = (stores[table] ?? []).filter((r) => filters.every((f) => matches(r, f)));
        if (take != null) rows = rows.slice(0, take);
        return { data: rows, error: null };
      };
      b.maybeSingle = () => Promise.resolve({ data: resolve().data[0] ?? null, error: null });
      b.single = () => Promise.resolve({ data: resolve().data[0] ?? null, error: null });
      b.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR);
      return b;
    },
  };
}

const DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A guide about the search console panel and how impressions behave.' }] }],
};

function contentRow(projectId: string, id: string, overrides: Row = {}): Row {
  return {
    id,
    project_id: projectId,
    title: 'Search console guide',
    slug: 'search-console',
    url: 'https://example.com/blog/search-console',
    status: 'published',
    target_keyword: 'search console',
    meta_title: 'Search console guide',
    meta_description: 'How search console impressions work.',
    content_json: DOC,
    content_html: '<p>test</p>',
    seo_score: 50,
    ...overrides,
  };
}

function container(stores: Store): ServiceContainer {
  return {
    config: { env: {} },
    registry: {},
    sb: filterSb(stores),
    jobStore: {},
  } as unknown as ServiceContainer;
}

/** Project "proj-a" is linked to property "prop-a" (host example.com) and has
 *  one matched page row; "proj-b" is a separate project with its own active GSC
 *  data source but no linked property and no page rows. */
function linkedStore(overrides: Partial<Store> = {}): Store {
  return {
    seo_content: [contentRow('proj-a', 'content-a'), contentRow('proj-b', 'content-b', { url: 'https://other.example.org/blog/x' })],
    seo_projects: [
      { id: 'proj-a', account_id: 'acct-1' },
      { id: 'proj-b', account_id: 'acct-1' },
    ],
    seo_data_sources: [
      { id: 'ds-a', project_id: 'proj-a', provider_type: 'gsc', status: 'active' },
      { id: 'ds-b', project_id: 'proj-b', provider_type: 'gsc', status: 'active' },
    ],
    seo_project_properties: [{ project_id: 'proj-a', property_id: 'prop-a', is_primary: true }],
    seo_gsc_properties: [{ id: 'prop-a', site_url: 'https://example.com/', is_active: true }],
    seo_gsc_pages: [
      { project_id: 'proj-a', url: 'https://example.com/blog/search-console', date: daysAgo(10), clicks: 4, impressions: 400, ctr: 0.01, position: 9.5 },
    ],
    seo_gsc_queries: [],
    seo_integrations: [],
    seo_knowledge_sources: [],
    ...overrides,
  };
}

describe('ContentIntelligenceService GSC property resolution (P8-A)', () => {
  it('receives GSC page signals for a project that links its account property', async () => {
    const svc = new ContentIntelligenceService(container(linkedStore()));
    const report = await svc.report('proj-a', 'content-a');
    const gsc = report.sources.find((s) => s.id === 'gsc');
    expect(gsc?.state).toBe('configured');
    expect(gsc?.note ?? null).toBeNull();
  });

  it('matches page signals through the linked property host when content has only a slug', async () => {
    const stores = linkedStore({
      seo_content: [contentRow('proj-a', 'content-a', { url: null })],
      seo_gsc_pages: [
        { project_id: 'proj-a', url: 'https://example.com/search-console', date: daysAgo(10), clicks: 4, impressions: 400, ctr: 0.01, position: 9.5 },
      ],
    });
    const svc = new ContentIntelligenceService(container(stores));
    const report = await svc.report('proj-a', 'content-a');
    const gsc = report.sources.find((s) => s.id === 'gsc');
    // note is null only when a page row matched, proving the host came from the
    // linked registry property rather than the content's own (absent) URL.
    expect(gsc?.state).toBe('configured');
    expect(gsc?.note ?? null).toBeNull();
  });

  it('does not leak another project GSC page signals to an unrelated project', async () => {
    const svc = new ContentIntelligenceService(container(linkedStore()));
    const report = await svc.report('proj-b', 'content-b');
    const gsc = report.sources.find((s) => s.id === 'gsc');
    expect(gsc?.state).toBe('no_data');
    expect(report.recommendations.some((r) => r.source === 'gsc' && r.code === 'page_visibility_decline')).toBe(false);
  });

  it('reports not_configured when the project has no GSC data source', async () => {
    const stores = linkedStore({ seo_data_sources: [] });
    const svc = new ContentIntelligenceService(container(stores));
    const report = await svc.report('proj-a', 'content-a');
    expect(report.sources.find((s) => s.id === 'gsc')?.state).toBe('not_configured');
  });

  it('always evaluates on-page SEO and returns the requested content identity', async () => {
    const svc = new ContentIntelligenceService(container(linkedStore()));
    const report = await svc.report('proj-a', 'content-a');
    expect(report.content_id).toBe('content-a');
    expect(report.sources.find((s) => s.id === 'seo')?.state).toBe('configured');
  });
});
