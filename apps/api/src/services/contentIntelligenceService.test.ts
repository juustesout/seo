import { describe, expect, it } from 'vitest';
import type { ServiceContainer } from '../context.js';
import { ContentIntelligenceService } from './contentIntelligenceService.js';

type Store = Record<string, unknown[]>;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

/** Minimal Supabase-like client: returns canned rows per table, ignores filters. */
function fakeSb(stores: Store) {
  const chain = (rows: unknown[]) => {
    const b = (() => undefined) as unknown as Record<string, unknown>;
    const thenable = Promise.resolve({ data: rows, error: null });
    b.select = () => b;
    b.eq = () => b;
    b.is = () => b;
    b.in = () => b;
    b.ilike = () => b;
    b.gte = () => b;
    b.limit = () => b;
    b.order = () => b;
    b.range = () => b;
    b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    b.single = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    b.then = thenable.then.bind(thenable);
    return b;
  };
  return { from: (table: string) => chain(stores[table] ?? []) };
}

const DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A guide about the search console panel and how impressions behave.' }] }],
};

function contentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-0000000000cc',
    project_id: '00000000-0000-0000-0000-0000000000bb',
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
  const sb = fakeSb(stores);
  return {
    config: { env: {} },
    registry: {},
    sb,
    jobStore: {},
  } as unknown as ServiceContainer;
}

const baseStores: Store = {
  seo_content: [contentRow()],
  seo_projects: [{ account_id: null }],
  seo_data_sources: [],
  seo_integrations: [],
  seo_knowledge_sources: [],
};

describe('ContentIntelligenceService report wiring', () => {
  it('reports unavailable sources without breaking and always evaluates SEO', async () => {
    const svc = new ContentIntelligenceService(container(baseStores));
    const report = await svc.report('p1', 'c1');
    expect(report.content_id).toBe('c1');
    expect(typeof report.seo_score).toBe('number');
    expect(report.ai).toMatchObject({ requested: false, available: false });

    const byId = new Map(report.sources.map((s) => [s.id, s.state]));
    expect(byId.get('gsc')).toBe('not_configured');
    expect(byId.get('dataforseo')).toBe('not_configured');
    expect(byId.get('knowledge')).toBe('not_configured');
    expect(byId.get('seo')).toBe('configured');
    expect(report.sources.find((s) => s.id === 'knowledge')?.note).toContain('QDRANT_URL');
  });

  it('uses matched GSC page rows for trend + topic query opportunities', async () => {
    const stores: Store = {
      ...baseStores,
      seo_data_sources: [{ id: 'ds1', provider_type: 'gsc', status: 'active' }],
      seo_gsc_properties: [{ site_url: 'https://example.com/' }],
      seo_gsc_pages: [
        { url: 'https://example.com/blog/search-console', date: daysAgo(45), clicks: 20, impressions: 900, ctr: 0.022, position: 9 },
        { url: 'https://example.com/blog/search-console', date: daysAgo(10), clicks: 4, impressions: 400, ctr: 0.01, position: 9.5 },
      ],
      seo_gsc_queries: [
        { query: 'search console tips', clicks: 2, impressions: 800, ctr: 0.0025, position: 6.5, date: daysAgo(5) },
      ],
    };
    const svc = new ContentIntelligenceService(container(stores));
    const report = await svc.report('p1', 'c1');

    expect(report.sources.find((s) => s.id === 'gsc')?.state).toBe('configured');
    expect(report.recommendations.some((r) => r.code === 'page_visibility_decline')).toBe(true);
    expect(report.recommendations.some((r) => r.code === 'low_ctr_query')).toBe(true);
  });

  it('adds DataForSEO demand when a tracked keyword row exists', async () => {
    const stores: Store = {
      ...baseStores,
      seo_integrations: [{ id: 'i1', provider_type: 'dataforseo', status: 'connected' }],
      seo_keywords: [
        { keyword: 'search console', volume: 1500, difficulty: 28, cpc: 1.4, provider: 'dataforseo' },
      ],
    };
    const svc = new ContentIntelligenceService(container(stores));
    const report = await svc.report('p1', 'c1');

    const df = report.sources.find((s) => s.id === 'dataforseo');
    expect(df?.state).toBe('configured');
    const demand = report.recommendations.find((r) => r.code === 'keyword_demand');
    expect(demand).toBeDefined();
    expect(demand!.source).toBe('dataforseo');
    expect(demand!.description).toContain('1,500');
  });

  it('suggests research when DataForSEO is connected but the target is not tracked', async () => {
    const stores: Store = {
      ...baseStores,
      seo_integrations: [{ id: 'i1', provider_type: 'dataforseo', status: 'connected' }],
      seo_keywords: [],
    };
    const svc = new ContentIntelligenceService(container(stores));
    const report = await svc.report('p1', 'c1');
    const gap = report.recommendations.find((r) => r.code === 'research_gap');
    expect(gap).toBeDefined();
    expect(report.sources.find((s) => s.id === 'dataforseo')?.state).toBe('no_data');
  });

  it('reflects knowledge source health when knowledge is configured server-side', async () => {
    const stores: Store = {
      ...baseStores,
      seo_knowledge_sources: [
        { status: 'indexed' },
        { status: 'indexed' },
        { status: 'error' },
      ],
    };
    const sb = fakeSb(stores);
    const containerInstance = {
      config: {
        env: { QDRANT_URL: 'http://qdrant:6333', QDRANT_API_KEY: 'k', OPENAI_API_KEY: 'sk' },
      },
      registry: { getKnowledge: () => ({ id: 'qdrant' }) },
      sb,
      jobStore: {},
    } as unknown as ServiceContainer;
    const svc = new ContentIntelligenceService(containerInstance);
    const report = await svc.report('p1', 'c1');
    expect(report.sources.find((s) => s.id === 'knowledge')?.state).toBe('configured');
    expect(report.recommendations.some((r) => r.code === 'source_errors')).toBe(true);
  });
});
