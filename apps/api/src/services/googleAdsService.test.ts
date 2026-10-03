/**
 * GoogleAdsService tests (P5). Cover connection state, live customer
 * discovery/validation (including manager expansion), project binding, report
 * normalization, the refresh-once-on-401 lifecycle, provider error mapping and
 * the per-request usage facts - all with a fake Supabase + fake credential
 * store and a stubbed fetch, so no network is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleAdsService, resolveAdsPeriodDays } from './googleAdsService.js';
import { InMemoryUsageEventStore } from './usageEventRepository.js';
import type { ServiceContainer } from '../context.js';

type Row = Record<string, unknown>;

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function response(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
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
    config: { env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_ADS_API_VERSION: 'v25' } },
  } as unknown as ServiceContainer;
  return container;
}

function baseTables(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    seo_integrations: [
      { id: 'int-ads', account_id: ACCOUNT, project_id: null, provider_type: 'ads', status: 'connected', config: { google_email: 'user@example.com' }, last_error: null },
    ],
    seo_project_ads: [],
    ...overrides,
  };
}

function customerRow(id: string, name: string, opts: { manager?: boolean; currency?: string; status?: string } = {}): Row {
  return {
    id,
    descriptiveName: name,
    currencyCode: opts.currency ?? 'USD',
    manager: opts.manager ?? false,
    status: opts.status ?? 'ENABLED',
  };
}

interface StubConfig {
  accessible?: string[];
  customers?: Record<string, Row>;
  managed?: Record<string, Row[]>;
  searchTerms?: Row[];
  keywords?: Row[];
  onRequest?: (query: string) => void;
}

function adsFetch(config: StubConfig): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as { query?: string }) : {};
    const query = body.query ?? '';
    if (query) config.onRequest?.(query);
    const id = u.match(/\/customers\/([0-9]+)\//)?.[1] ?? '';
    if (u.includes('customers:listAccessibleCustomers')) {
      return response({ resourceNames: (config.accessible ?? []).map((c) => `customers/${c}`) });
    }
    if (query.includes('FROM customer_client')) {
      return response([{ results: (config.managed?.[id] ?? []).map((c) => ({ customerClient: c })) }]);
    }
    if (query.includes('FROM customer')) {
      const c = config.customers?.[id];
      return response(c ? [{ results: [{ customer: c }] }] : []);
    }
    if (query.includes('FROM search_term_view')) {
      return response([{ results: config.searchTerms ?? [] }]);
    }
    if (query.includes('FROM keyword_view')) {
      return response([{ results: config.keywords ?? [] }]);
    }
    return response({}, 404);
  }) as unknown as typeof fetch;
}

const NOW = () => new Date('2026-09-29T12:00:00Z');

describe('resolveAdsPeriodDays', () => {
  it('accepts only the supported periods and defaults to 28', () => {
    expect(resolveAdsPeriodDays('7')).toBe(7);
    expect(resolveAdsPeriodDays(90)).toBe(90);
    expect(resolveAdsPeriodDays('365')).toBe(28);
    expect(resolveAdsPeriodDays(undefined)).toBe(28);
  });
});

describe('GoogleAdsService', () => {
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
    const svc = new GoogleAdsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    expect(await svc.connectionState(ACCOUNT)).toEqual({
      connected: true,
      integration_id: 'int-ads',
      status: 'connected',
      account_email: 'user@example.com',
      error: null,
    });
  });

  it('reports not connected when no Ads integration exists', async () => {
    const svc = new GoogleAdsService(makeContainer(baseTables({ seo_integrations: [] }), tokens, credsSet), NOW);
    expect(await svc.connectionState(ACCOUNT)).toMatchObject({ connected: false, integration_id: null, account_email: null });
  });

  it('discovers directly accessible customers', async () => {
    vi.stubGlobal(
      'fetch',
      adsFetch({
        accessible: ['111', '222'],
        customers: { '111': customerRow('111', 'Acme'), '222': customerRow('222', 'Shop', { currency: 'EUR' }) },
      }),
    );
    const svc = new GoogleAdsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    expect(await svc.listCustomers(ACCOUNT)).toEqual([
      { customer_id: '111', name: 'Acme', currency_code: 'USD', is_manager: false, login_customer_id: null, status: 'ENABLED' },
      { customer_id: '222', name: 'Shop', currency_code: 'EUR', is_manager: false, login_customer_id: null, status: 'ENABLED' },
    ]);
  });

  it('expands manager accounts to their clients with a login-customer-id', async () => {
    vi.stubGlobal(
      'fetch',
      adsFetch({
        accessible: ['111'],
        customers: { '111': customerRow('111', 'MCC', { manager: true }) },
        managed: { '111': [customerRow('222', 'Client')] },
      }),
    );
    const svc = new GoogleAdsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    const customers = await svc.listCustomers(ACCOUNT);
    expect(customers).toContainEqual({
      customer_id: '222',
      name: 'Client',
      currency_code: 'USD',
      is_manager: false,
      login_customer_id: '111',
      status: 'ENABLED',
    });
  });

  it('refuses discovery when Google Ads is not connected', async () => {
    const svc = new GoogleAdsService(makeContainer(baseTables({ seo_integrations: [] }), tokens, credsSet), NOW);
    await expect(svc.listCustomers(ACCOUNT)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a malformed customer id', async () => {
    const svc = new GoogleAdsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    await expect(svc.resolveCustomer(ACCOUNT, 'not-a-number')).rejects.toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('rejects a customer the account cannot access', async () => {
    vi.stubGlobal('fetch', adsFetch({ accessible: [], customers: {} }));
    const svc = new GoogleAdsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    await expect(svc.resolveCustomer(ACCOUNT, '999')).rejects.toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('binds a validated customer with authoritative metadata, never client input', async () => {
    const tables = baseTables();
    vi.stubGlobal(
      'fetch',
      adsFetch({ accessible: ['111'], customers: { '111': customerRow('111', 'Acme', { currency: 'GBP' }) } }),
    );
    const svc = new GoogleAdsService(makeContainer(tables, tokens, credsSet), NOW);
    const customer = await svc.selectCustomer({ accountId: ACCOUNT, projectId: PROJECT, userId: 'user-1', customerId: 'customers/111' });
    expect(customer).toEqual({ customer_id: '111', name: 'Acme', currency_code: 'GBP', is_manager: false, login_customer_id: null, status: 'ENABLED' });
    expect(tables.seo_project_ads![0]).toMatchObject({ project_id: PROJECT, customer_id: '111', customer_name: 'Acme', currency_code: 'GBP' });
  });

  it('reads and clears the project binding', async () => {
    const tables = baseTables({
      seo_project_ads: [
        { project_id: PROJECT, customer_id: '111', customer_name: 'Acme', currency_code: 'USD', is_manager: false, login_customer_id: null },
      ],
    });
    const svc = new GoogleAdsService(makeContainer(tables, tokens, credsSet), NOW);
    expect(await svc.currentCustomer(PROJECT)).toEqual({
      customer_id: '111',
      name: 'Acme',
      currency_code: 'USD',
      is_manager: false,
      login_customer_id: null,
      status: null,
    });
    await svc.clearCustomer(PROJECT);
    expect(tables.seo_project_ads).toHaveLength(0);
  });

  it('returns an empty report (no Google call) when the project has no customer', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const svc = new GoogleAdsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    const report = await svc.report({ accountId: ACCOUNT, projectId: PROJECT, days: 28 });
    expect(report).toEqual({
      customer: null,
      period: { days: 28, start_date: '2026-09-02', end_date: '2026-09-29' },
      search_terms: [],
      keywords: [],
      limit: 100,
      search_terms_truncated: false,
      keywords_truncated: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an unsafe filter before calling Google', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const svc = new GoogleAdsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    await expect(svc.report({ accountId: ACCOUNT, projectId: PROJECT, days: 28, filter: "bad' OR 1=1" })).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('normalizes search terms and keywords for the bound customer', async () => {
    const tables = baseTables({
      seo_project_ads: [
        { project_id: PROJECT, customer_id: '111', customer_name: 'Acme', currency_code: 'USD', is_manager: false, login_customer_id: null },
      ],
    });
    vi.stubGlobal(
      'fetch',
      adsFetch({
        searchTerms: [
          { searchTermView: { searchTerm: 'running shoes', status: 'NONE' }, metrics: { impressions: '1000', clicks: '50', costMicros: '2500000', conversions: '3', ctr: '0.05' } },
        ],
        keywords: [
          { adGroupCriterion: { keyword: { text: 'buy shoes', matchType: 'EXACT' }, status: 'ENABLED' }, campaign: { name: 'Brand' }, adGroup: { name: 'Search' }, metrics: { impressions: '10', clicks: '2', costMicros: '1000000', conversions: '1', ctr: '0.2' } },
        ],
      }),
    );
    const svc = new GoogleAdsService(makeContainer(tables, tokens, credsSet), NOW);
    const report = await svc.report({ accountId: ACCOUNT, projectId: PROJECT, days: 7 });
    expect(report.customer).toEqual({ customer_id: '111', name: 'Acme', currency_code: 'USD' });
    expect(report.period).toEqual({ days: 7, start_date: '2026-09-23', end_date: '2026-09-29' });
    expect(report.search_terms).toEqual([
      { search_term: 'running shoes', status: 'NONE', impressions: 1000, clicks: 50, cost: 2.5, conversions: 3, ctr: 0.05 },
    ]);
    expect(report.keywords[0]).toMatchObject({ keyword_text: 'buy shoes', match_type: 'EXACT', cost: 1 });
  });

  it('refreshes once on a 401 and retries the report', async () => {
    const tables = baseTables({
      seo_project_ads: [
        { project_id: PROJECT, customer_id: '111', customer_name: 'Acme', currency_code: 'USD', is_manager: false, login_customer_id: null },
      ],
    });
    let dataCalls = 0;
    vi.stubGlobal('fetch', (async (url: string, init?: RequestInit) => {
      if (String(url).includes('oauth2.googleapis.com')) return response({ access_token: 'access-2', expires_in: 3600 });
      const body = init?.body ? (JSON.parse(String(init.body)) as { query?: string }) : {};
      const query = body.query ?? '';
      dataCalls += 1;
      if (dataCalls === 1) return response({ error: { message: 'expired' } }, 401);
      if (query.includes('FROM search_term_view')) return response([{ results: [{ searchTermView: { searchTerm: 'seo' }, metrics: { impressions: '5' } }] }]);
      return response([{ results: [] }]);
    }) as unknown as typeof fetch);
    const svc = new GoogleAdsService(makeContainer(tables, tokens, credsSet), NOW);
    const report = await svc.report({ accountId: ACCOUNT, projectId: PROJECT, days: 28 });
    expect(report.search_terms[0]).toMatchObject({ search_term: 'seo', impressions: 5 });
    expect(credsSet).toContainEqual(['google_access_token', 'access-2']);
  });

  it('requires reauthorization after two consecutive 401s', async () => {
    const tables = baseTables({
      seo_project_ads: [
        { project_id: PROJECT, customer_id: '111', customer_name: 'Acme', currency_code: 'USD', is_manager: false, login_customer_id: null },
      ],
    });
    vi.stubGlobal('fetch', (async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) return response({ access_token: 'access-2' });
      return response({ error: { message: 'nope' } }, 401);
    }) as unknown as typeof fetch);
    const svc = new GoogleAdsService(makeContainer(tables, tokens, credsSet), NOW);
    await expect(svc.report({ accountId: ACCOUNT, projectId: PROJECT, days: 28 })).rejects.toMatchObject({
      status: 403,
      code: 'ads_reauthorization_required',
    });
  });

  it('maps a quota failure to 429 ads_quota_exceeded', async () => {
    const tables = baseTables({
      seo_project_ads: [
        { project_id: PROJECT, customer_id: '111', customer_name: 'Acme', currency_code: 'USD', is_manager: false, login_customer_id: null },
      ],
    });
    vi.stubGlobal('fetch', (async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) return response({ access_token: 'access-2' });
      return response({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 429);
    }) as unknown as typeof fetch);
    const svc = new GoogleAdsService(makeContainer(tables, tokens, credsSet), NOW);
    await expect(svc.report({ accountId: ACCOUNT, projectId: PROJECT, days: 28 })).rejects.toMatchObject({
      status: 429,
      code: 'ads_quota_exceeded',
    });
  });

  it('maps a permission failure to 403 ads_permission_denied', async () => {
    vi.stubGlobal('fetch', (async () =>
      response(
        { error: { status: 'PERMISSION_DENIED', message: 'no', details: [{ errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' } }] }] } },
        403,
      )) as unknown as typeof fetch);
    const svc = new GoogleAdsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    await expect(svc.listCustomers(ACCOUNT)).rejects.toMatchObject({ status: 403, code: 'ads_permission_denied' });
  });

  it('maps an unknown customer to a 400 bad_request', async () => {
    vi.stubGlobal('fetch', (async () =>
      response(
        { error: { status: 'NOT_FOUND', message: 'gone', details: [{ errors: [{ errorCode: { requestError: 'CUSTOMER_NOT_FOUND' } }] }] } },
        404,
      )) as unknown as typeof fetch);
    const svc = new GoogleAdsService(makeContainer(baseTables(), tokens, credsSet), NOW);
    await expect(svc.listCustomers(ACCOUNT)).rejects.toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('records one ads_request fact per real Google Ads request (P5)', async () => {
    const tables = baseTables({
      seo_project_ads: [
        { project_id: PROJECT, customer_id: '111', customer_name: 'Acme', currency_code: 'USD', is_manager: false, login_customer_id: null },
      ],
    });
    vi.stubGlobal('fetch', adsFetch({ searchTerms: [], keywords: [] }));
    const container = makeContainer(tables, tokens, credsSet);
    const store = new InMemoryUsageEventStore();
    (container as unknown as { usageEvents: InMemoryUsageEventStore }).usageEvents = store;
    const svc = new GoogleAdsService(container, NOW);

    await svc.report({ accountId: ACCOUNT, projectId: PROJECT, days: 7, userId: USER });

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.category === 'google' && e.provider === 'ads' && e.unit === 'ads_request' && e.success)).toBe(true);
    expect(events.map((e) => e.operation).sort()).toEqual(['keywords', 'search_terms']);
  });
});
