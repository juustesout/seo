/**
 * Project Ads route tests (P5 HTTP boundary).
 *
 * Mounts the real projectAdsRouter over a fake container + Supabase-like client
 * and a stubbed fetch, so the wire contract is tested end to end:
 * authentication, viewer/admin role boundaries, the `{ data }` envelope, the
 * honest no-customer report, project isolation and the customer id validation
 * (a client can never bind an arbitrary Google Ads customer).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { projectAdsRouter } from './projectAds.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'viewer-user' },
  'admin-token': { sub: 'admin-user' },
  'norole-token': { sub: 'no-role-user' },
};
const ROLE_BY_USER: Record<string, string | undefined> = { 'viewer-user': 'viewer', 'admin-user': 'admin' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

let currentStores: Store = {};

function response(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function fakeSb() {
  return {
    from(table: string) {
      const state: { filters: Array<(r: Row) => boolean>; limit: number | null } = { filters: [], limit: null };
      const apply = () => {
        let r = (currentStores[table] ?? []).filter((x) => state.filters.every((f) => f(x)));
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
          currentStores[table] = [...(currentStores[table] ?? []).filter((r) => r.project_id !== row.project_id), row];
          return builder;
        },
        delete: () => ({
          eq: (c: string, v: unknown) => {
            currentStores[table] = (currentStores[table] ?? []).filter((r) => r[c] !== v);
            return Promise.resolve({ error: null });
          },
        }),
      };
      return builder;
    },
  };
}

function defaultStores(): Store {
  return {
    seo_projects: [
      { id: PROJECT, account_id: ACCOUNT },
      { id: OTHER_PROJECT, account_id: ACCOUNT },
    ],
    seo_integrations: [
      { id: 'int-ads', account_id: ACCOUNT, project_id: null, provider_type: 'ads', status: 'connected', config: { google_email: 'user@example.com' }, last_error: null },
    ],
    seo_project_ads: [],
  };
}

function customerRow(id: string, name: string, opts: { manager?: boolean; currency?: string } = {}): Row {
  return { id, descriptiveName: name, currencyCode: opts.currency ?? 'USD', manager: opts.manager ?? false, status: 'ENABLED' };
}

/** A fetch stub answering the Ads discovery + searchStream queries by body. */
function adsFetch(config: { accessible: string[]; customers: Record<string, Row>; searchTerms?: Row[]; keywords?: Row[] }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as { query?: string }) : {};
    const query = body.query ?? '';
    const id = u.match(/\/customers\/([0-9]+)\//)?.[1] ?? '';
    if (u.includes('customers:listAccessibleCustomers')) return response({ resourceNames: config.accessible.map((c) => `customers/${c}`) });
    if (query.includes('FROM customer_client')) return response([{ results: [] }]);
    if (query.includes('FROM customer')) return response(config.customers[id] ? [{ results: [{ customer: config.customers[id] }] }] : []);
    if (query.includes('FROM search_term_view')) return response([{ results: config.searchTerms ?? [] }]);
    return response([{ results: config.keywords ?? [] }]);
  }) as unknown as typeof fetch;
}

let server: Server;
let base = '';
const realFetch = globalThis.fetch;

async function request(path: string, token?: string, method = 'GET', body?: unknown) {
  const res = await realFetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } } };
}

beforeEach(() => {
  currentStores = defaultStores();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/projects/:projectId/ads', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      (req as unknown as { container: unknown }).container = {
        access: {
          requireRole: async (userId: string, _projectId: string, minRole: string) => {
            const role = ROLE_BY_USER[userId];
            if (!role) throw ApiError.forbidden('You do not have access to this project');
            if ((ROLE_ORDER[role] ?? -1) < (ROLE_ORDER[minRole] ?? -1)) throw ApiError.forbidden(`This action requires the ${minRole} role`);
            return { project_id: PROJECT, role };
          },
        },
        config: { env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_ADS_API_VERSION: 'v25' } },
        sb: fakeSb(),
        credentials: {
          reader: () => ({
            get: async (key: string) => (key === 'google_access_token' ? 'access-1' : key === 'google_refresh_token' ? 'refresh-1' : null),
            set: async () => undefined,
            delete: async () => undefined,
          }),
        },
      };
      (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
      next();
    });
    app.use(`/api/projects/:projectId/ads`, projectAdsRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${PROJECT}/ads`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects an anonymous request', async () => {
    const res = await request('/state');
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe('unauthorized');
  });

  it('rejects an authenticated non-member', async () => {
    const res = await request('/state', 'norole-token');
    expect(res.status).toBe(403);
  });

  it('reports viewer state without a management capability', async () => {
    const res = await request('/state', 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({
      google: { connected: true, integration_id: 'int-ads', status: 'connected', account_email: 'user@example.com', error: null },
      current: null,
      can_manage: false,
    });
  });

  it('reports admin state with the management capability', async () => {
    const res = await request('/state', 'admin-token');
    expect(res.status).toBe(200);
    expect((res.json.data as { can_manage: boolean }).can_manage).toBe(true);
  });

  it('does not let a viewer select a customer', async () => {
    const res = await request('/customer', 'viewer-token', 'PUT', { customer_id: '111' });
    expect(res.status).toBe(403);
    expect(currentStores.seo_project_ads).toHaveLength(0);
  });

  it('lets an admin select a validated customer', async () => {
    vi.stubGlobal('fetch', adsFetch({ accessible: ['111'], customers: { '111': customerRow('111', 'Acme') } }));
    const res = await request('/customer', 'admin-token', 'PUT', { customer_id: '111' });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({
      customer: { customer_id: '111', name: 'Acme', currency_code: 'USD', is_manager: false, login_customer_id: null, status: 'ENABLED' },
    });
    expect(currentStores.seo_project_ads![0]).toMatchObject({ project_id: PROJECT, customer_id: '111', customer_name: 'Acme' });
  });

  it('rejects selecting a customer the account cannot access', async () => {
    vi.stubGlobal('fetch', adsFetch({ accessible: [], customers: {} }));
    const res = await request('/customer', 'admin-token', 'PUT', { customer_id: '999' });
    expect(res.status).toBe(400);
    expect(currentStores.seo_project_ads).toHaveLength(0);
  });

  it('returns an honest empty report when no customer is bound', async () => {
    const res = await request('/report', 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ customer: null, search_terms: [], keywords: [], limit: 100 });
  });

  it('returns normalized paid search intelligence for the bound customer', async () => {
    currentStores.seo_project_ads = [
      { project_id: PROJECT, customer_id: '111', customer_name: 'Acme', currency_code: 'USD', is_manager: false, login_customer_id: null },
    ];
    vi.stubGlobal(
      'fetch',
      adsFetch({
        accessible: ['111'],
        customers: { '111': customerRow('111', 'Acme') },
        searchTerms: [{ searchTermView: { searchTerm: 'seo tools' }, metrics: { impressions: '42', clicks: '4', costMicros: '5000000', conversions: '1', ctr: '0.1' } }],
        keywords: [{ adGroupCriterion: { keyword: { text: 'seo', matchType: 'BROAD' }, status: 'ENABLED' }, campaign: { name: 'C' }, adGroup: { name: 'G' }, metrics: { impressions: '10', clicks: '1', costMicros: '1000000', conversions: '0', ctr: '0.1' } }],
      }),
    );
    const res = await request('/report?days=7', 'viewer-token');
    expect(res.status).toBe(200);
    const data = res.json.data as { period: { days: number }; search_terms: unknown[]; keywords: unknown[] };
    expect(data.period.days).toBe(7);
    expect(data.search_terms).toEqual([
      { search_term: 'seo tools', status: null, impressions: 42, clicks: 4, cost: 5, conversions: 1, ctr: 0.1 },
    ]);
    expect(data.keywords[0]).toMatchObject({ keyword_text: 'seo', match_type: 'BROAD', campaign_name: 'C', ad_group_name: 'G' });
  });

  it("only reads this project's binding, never another project's", async () => {
    currentStores.seo_project_ads = [
      { project_id: PROJECT, customer_id: '111', customer_name: 'Mine', currency_code: 'USD', is_manager: false, login_customer_id: null },
      { project_id: OTHER_PROJECT, customer_id: '999', customer_name: "Someone else's", currency_code: 'USD', is_manager: false, login_customer_id: null },
    ];
    vi.stubGlobal(
      'fetch',
      adsFetch({ accessible: ['111'], customers: { '111': customerRow('111', 'Mine') }, searchTerms: [], keywords: [] }),
    );
    const res = await request('/report', 'viewer-token');
    expect(res.status).toBe(200);
    expect((res.json.data as { customer: { customer_id: string } }).customer.customer_id).toBe('111');
  });

  it('maps an expired Google authorization to a reconnect error', async () => {
    currentStores.seo_project_ads = [
      { project_id: PROJECT, customer_id: '111', customer_name: 'Acme', currency_code: 'USD', is_manager: false, login_customer_id: null },
    ];
    vi.stubGlobal('fetch', (async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) return response({ access_token: 'access-2' });
      return response({ error: { message: 'nope' } }, 401);
    }) as unknown as typeof fetch);
    const res = await request('/report', 'viewer-token');
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe('ads_reauthorization_required');
  });
});
