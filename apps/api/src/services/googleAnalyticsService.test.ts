/**
 * GoogleAnalyticsService tests (P4). Cover connection state, live property
 * discovery/validation, project binding, page-traffic normalization, the
 * refresh-once-on-401 lifecycle and provider error mapping - all with a fake
 * Supabase + fake credential store and a stubbed fetch, so no network is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleAnalyticsService, resolveAnalyticsPeriodDays } from './googleAnalyticsService.js';
import type { ServiceContainer } from '../context.js';

type Row = Record<string, unknown>;

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT = '11111111-1111-4111-8111-111111111111';

function response(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

function makeSb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const state: { filters: Array<(r: Row) => boolean>; limit: number | null } = { filters: [], limit: null };
      const rows = () => tables[table] ?? [];
      const apply = () => {
        let r = rows().filter((x) => state.filters.every((f) => f(x)));
        if (state.limit !== null) r = r.slice(0, state.limit);
        return r;
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: unknown) => {
          state.filters.push((r) => r[c] === v);
          return builder;
        },
        is: (c: string, v: unknown) => {
          state.filters.push((r) => r[c] === v);
          return builder;
        },
        order: () => builder,
        limit: (n: number) => {
          state.limit = n;
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: apply(), error: null }),
        upsert: (row: Row) => {
          tables[table] = [...(tables[table] ?? []).filter((r) => r.project_id !== row.project_id), row];
          return builder;
        },
        delete: () => ({
          eq: (c: string, v: unknown) => {
            tables[table] = (tables[table] ?? []).filter((r) => r[c] !== v);
            return Promise.resolve({ error: null });
          },
        }),
      };
      return builder;
    },
  };
}

function makeContainer(tables: Record<string, Row[]>, tokens: { access: string | null; refresh: string | null }, credsSet: Array<[string, string]>) {
  const container = {
    sb: makeSb(tables),
    credentials: {
      reader: () => ({
        get: async (key: string) => (key === 'google_access_token' ? tokens.access : key === 'google_refresh_token' ? tokens.refresh : null),
        set: async (key: string, value: string) => {
          credsSet.push([key, value]);
          if (key === 'google_access_token') tokens.access = value;
        },
        delete: async () => undefined,
      }),
    },
    config: { env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret' } },
  } as unknown as ServiceContainer;
  return container;
}

function baseTables(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    seo_integrations: [
      { id: 'int-ga4', account_id: ACCOUNT, project_id: null, provider_type: 'ga4', status: 'connected', config: { google_email: 'user@example.com' }, last_error: null },
    ],
    seo_project_analytics: [],
    ...overrides,
  };
}

const NOW = () => new Date('2026-09-29T12:00:00Z');

describe('resolveAnalyticsPeriodDays', () => {
  it('accepts only the supported periods and defaults to 28', () => {
    expect(resolveAnalyticsPeriodDays('7')).toBe(7);
    expect(resolveAnalyticsPeriodDays(90)).toBe(90);
    expect(resolveAnalyticsPeriodDays('365')).toBe(28);
    expect(resolveAnalyticsPeriodDays(undefined)).toBe(28);
  });
});

describe('GoogleAnalyticsService', () => {
  let tokens: { access: string | null; refresh: string | null };
  let credsSet: Array<[string, string]>;

  beforeEach(() => {
    tokens = { access: 'access-1', refresh: 'refresh-1' };
    credsSet = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports connection state with the connected Google identity', async () => {
    const svc = new GoogleAnalyticsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    expect(await svc.connectionState(ACCOUNT)).toEqual({
      connected: true,
      integration_id: 'int-ga4',
      status: 'connected',
      account_email: 'user@example.com',
      error: null,
    });
  });

  it('reports not connected when no GA4 integration exists', async () => {
    const svc = new GoogleAnalyticsService(makeContainer(baseTables({ seo_integrations: [] }), tokens, credsSet), NOW);
    expect(await svc.connectionState(ACCOUNT)).toMatchObject({ connected: false, integration_id: null, account_email: null });
  });

  it('discovers properties, mapping real Google metadata', async () => {
    vi.stubGlobal('fetch', (async (url: string) => {
      if (String(url).includes('accountSummaries')) {
        return response({ accountSummaries: [{ propertySummaries: [{ property: 'properties/111', displayName: 'My Website' }] }] });
      }
      return response({ dataStreams: [{ type: 'WEB', webStreamData: { defaultUri: 'https://example.com' } }] });
    }) as unknown as typeof fetch);
    const svc = new GoogleAnalyticsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    expect(await svc.listProperties(ACCOUNT)).toEqual([{ property_id: '111', property_name: 'My Website', property_url: 'https://example.com' }]);
  });

  it('refuses discovery when Google Analytics is not connected', async () => {
    const svc = new GoogleAnalyticsService(makeContainer(baseTables({ seo_integrations: [] }), tokens, credsSet), NOW);
    await expect(svc.listProperties(ACCOUNT)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a property id the account cannot access', async () => {
    vi.stubGlobal('fetch', (async (url: string) => {
      if (String(url).includes('accountSummaries')) return response({ accountSummaries: [] });
      return response({ dataStreams: [] });
    }) as unknown as typeof fetch);
    const svc = new GoogleAnalyticsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    await expect(svc.resolveProperty(ACCOUNT, '999')).rejects.toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('binds a validated property with authoritative name/url, never client input', async () => {
    const tables = baseTables();
    vi.stubGlobal('fetch', (async (url: string) => {
      if (String(url).includes('accountSummaries')) {
        return response({ accountSummaries: [{ propertySummaries: [{ property: 'properties/111', displayName: 'My Website' }] }] });
      }
      return response({ dataStreams: [{ type: 'WEB', webStreamData: { defaultUri: 'https://example.com' } }] });
    }) as unknown as typeof fetch);
    const svc = new GoogleAnalyticsService(makeContainer(tables, tokens, credsSet), NOW);
    const property = await svc.selectProperty({ accountId: ACCOUNT, projectId: PROJECT, userId: 'user-1', propertyId: 'properties/111' });
    expect(property).toEqual({ property_id: '111', property_name: 'My Website', property_url: 'https://example.com' });
    expect(tables.seo_project_analytics[0]).toMatchObject({ project_id: PROJECT, property_id: '111', property_name: 'My Website' });
  });

  it('returns an empty report (no Google call) when the project has no property', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const svc = new GoogleAnalyticsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    const report = await svc.pageTraffic({ accountId: ACCOUNT, projectId: PROJECT, days: 28 });
    expect(report).toEqual({
      property: null,
      period: { days: 28, start_date: '2026-09-02', end_date: '2026-09-29' },
      rows: [],
      limit: 100,
      truncated: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a normalized page-traffic report for the bound property', async () => {
    const tables = baseTables({ seo_project_analytics: [{ project_id: PROJECT, property_id: '111', property_name: 'My Website', property_url: 'https://example.com' }] });
    vi.stubGlobal('fetch', (async () =>
      response({ rows: [{ dimensionValues: [{ value: '/blog/seo-guide' }], metricValues: [{ value: '2184' }, { value: '1731' }, { value: '2000' }] }], rowCount: 1 })) as unknown as typeof fetch);
    const svc = new GoogleAnalyticsService(makeContainer(tables, tokens, credsSet), NOW);
    const report = await svc.pageTraffic({ accountId: ACCOUNT, projectId: PROJECT, days: 7 });
    expect(report.property).toEqual({ property_id: '111', property_name: 'My Website', property_url: 'https://example.com' });
    expect(report.period).toEqual({ days: 7, start_date: '2026-09-23', end_date: '2026-09-29' });
    expect(report.rows).toEqual([{ path: '/blog/seo-guide', views: 2184, active_users: 1731, sessions: 2000 }]);
  });

  it('refreshes once on a 401 and retries the report', async () => {
    const tables = baseTables({ seo_project_analytics: [{ project_id: PROJECT, property_id: '111', property_name: 'My Website', property_url: null }] });
    let dataCalls = 0;
    const seenAuth: string[] = [];
    vi.stubGlobal('fetch', (async (url: string, init?: RequestInit) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return response({ access_token: 'access-2', expires_in: 3600 });
      }
      dataCalls += 1;
      seenAuth.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
      if (dataCalls === 1) return response({ error: { message: 'expired' } }, 401);
      return response({ rows: [{ dimensionValues: [{ value: '/' }], metricValues: [{ value: '5' }, { value: '4' }, { value: '3' }] }], rowCount: 1 });
    }) as unknown as typeof fetch);
    const svc = new GoogleAnalyticsService(makeContainer(tables, tokens, credsSet), NOW);
    const report = await svc.pageTraffic({ accountId: ACCOUNT, projectId: PROJECT, days: 28 });
    expect(report.rows).toEqual([{ path: '/', views: 5, active_users: 4, sessions: 3 }]);
    expect(seenAuth).toEqual(['Bearer access-1', 'Bearer access-2']);
    expect(credsSet).toContainEqual(['google_access_token', 'access-2']);
  });

  it('requires reauthorization after two consecutive 401s', async () => {
    const tables = baseTables({ seo_project_analytics: [{ project_id: PROJECT, property_id: '111', property_name: 'My Website', property_url: null }] });
    vi.stubGlobal('fetch', (async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) return response({ access_token: 'access-2' });
      return response({ error: { message: 'nope' } }, 401);
    }) as unknown as typeof fetch);
    const svc = new GoogleAnalyticsService(makeContainer(tables, tokens, credsSet), NOW);
    await expect(svc.pageTraffic({ accountId: ACCOUNT, projectId: PROJECT, days: 28 })).rejects.toMatchObject({
      status: 403,
      code: 'analytics_reauthorization_required',
    });
  });

  it('maps a Google API failure to a 502 analytics_unavailable', async () => {
    const tables = baseTables({ seo_project_analytics: [{ project_id: PROJECT, property_id: '111', property_name: 'My Website', property_url: null }] });
    vi.stubGlobal('fetch', (async () => response({ error: { message: 'quota' } }, 429)) as unknown as typeof fetch);
    const svc = new GoogleAnalyticsService(makeContainer(tables, tokens, credsSet), NOW);
    await expect(svc.pageTraffic({ accountId: ACCOUNT, projectId: PROJECT, days: 28 })).rejects.toMatchObject({
      status: 502,
      code: 'analytics_unavailable',
    });
  });
});
