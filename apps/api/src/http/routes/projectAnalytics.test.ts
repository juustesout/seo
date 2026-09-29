/**
 * Project Analytics route tests (P4 HTTP boundary).
 *
 * Mounts the real projectAnalyticsRouter over a fake container + Supabase-like
 * client and a stubbed fetch, so the wire contract is tested end to end:
 * authentication, viewer/admin role boundaries, the `{ data }` envelope, the
 * honest no-property report, project isolation and the property id validation
 * (a client can never bind an arbitrary Google property).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { projectAnalyticsRouter } from './projectAnalytics.js';

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
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
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
      { id: 'int-ga4', account_id: ACCOUNT, project_id: null, provider_type: 'ga4', status: 'connected', config: { google_email: 'user@example.com' }, last_error: null },
    ],
    seo_project_analytics: [],
  };
}

let server: Server;
let base = '';
// Captured before any test stubs the global: the test's own HTTP calls must use
// the real fetch, while the GA4 client under test sees the stubbed one.
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

describe('/api/projects/:projectId/analytics', () => {
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
            if ((ROLE_ORDER[role] ?? -1) < ROLE_ORDER[minRole]) throw ApiError.forbidden(`This action requires the ${minRole} role`);
            return { project_id: PROJECT, role };
          },
        },
        config: { env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret' } },
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
    app.use(`/api/projects/:projectId/analytics`, projectAnalyticsRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${PROJECT}/analytics`;
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
      google: { connected: true, integration_id: 'int-ga4', status: 'connected', account_email: 'user@example.com', error: null },
      current: null,
      can_manage: false,
    });
  });

  it('reports admin state with the management capability', async () => {
    const res = await request('/state', 'admin-token');
    expect(res.status).toBe(200);
    expect((res.json.data as { can_manage: boolean }).can_manage).toBe(true);
  });

  it('does not let a viewer select a property', async () => {
    const res = await request('/property', 'viewer-token', 'PUT', { property_id: '111' });
    expect(res.status).toBe(403);
    expect(currentStores.seo_project_analytics).toHaveLength(0);
  });

  it('lets an admin select a validated property', async () => {
    vi.stubGlobal('fetch', (async (url: string) => {
      if (String(url).includes('accountSummaries')) {
        return response({ accountSummaries: [{ propertySummaries: [{ property: 'properties/111', displayName: 'My Website' }] }] });
      }
      return response({ dataStreams: [{ type: 'WEB', webStreamData: { defaultUri: 'https://example.com' } }] });
    }) as unknown as typeof fetch);
    const res = await request('/property', 'admin-token', 'PUT', { property_id: '111' });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ property: { property_id: '111', property_name: 'My Website', property_url: 'https://example.com' } });
    expect(currentStores.seo_project_analytics[0]).toMatchObject({ project_id: PROJECT, property_id: '111' });
  });

  it('rejects selecting a property the account cannot access', async () => {
    vi.stubGlobal('fetch', (async (url: string) => (String(url).includes('accountSummaries') ? response({ accountSummaries: [] }) : response({ dataStreams: [] }))) as unknown as typeof fetch);
    const res = await request('/property', 'admin-token', 'PUT', { property_id: '999' });
    expect(res.status).toBe(400);
    expect(currentStores.seo_project_analytics).toHaveLength(0);
  });

  it('returns an honest empty page-traffic report when no property is bound', async () => {
    const res = await request('/page-traffic', 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ property: null, rows: [], truncated: false, limit: 100 });
  });

  it('returns normalized page traffic for the bound property', async () => {
    currentStores.seo_project_analytics = [{ project_id: PROJECT, property_id: '111', property_name: 'My Website', property_url: 'https://example.com' }];
    vi.stubGlobal('fetch', (async () =>
      response({ rows: [{ dimensionValues: [{ value: '/' }], metricValues: [{ value: '4821' }, { value: '3902' }, { value: '4500' }] }], rowCount: 1 })) as unknown as typeof fetch);
    const res = await request('/page-traffic?days=7', 'viewer-token');
    expect(res.status).toBe(200);
    const data = res.json.data as { rows: unknown[]; period: { days: number } };
    expect(data.period.days).toBe(7);
    expect(data.rows).toEqual([{ path: '/', views: 4821, active_users: 3902, sessions: 4500 }]);
  });

  it("only reads this project's binding, never another project's", async () => {
    currentStores.seo_project_analytics = [
      { project_id: PROJECT, property_id: '111', property_name: 'Mine', property_url: null },
      { project_id: OTHER_PROJECT, property_id: '999', property_name: "Someone else's", property_url: null },
    ];
    vi.stubGlobal('fetch', (async () =>
      response({ rows: [{ dimensionValues: [{ value: '/' }], metricValues: [{ value: '1' }, { value: '1' }, { value: '1' }] }], rowCount: 1 })) as unknown as typeof fetch);
    const res = await request('/page-traffic', 'viewer-token');
    expect(res.status).toBe(200);
    expect((res.json.data as { property: { property_id: string } }).property.property_id).toBe('111');
  });

  it('maps an expired Google authorization to a reconnect error', async () => {
    currentStores.seo_project_analytics = [{ project_id: PROJECT, property_id: '111', property_name: 'My Website', property_url: null }];
    vi.stubGlobal('fetch', (async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) return response({ access_token: 'access-2' });
      return response({ error: { message: 'nope' } }, 401);
    }) as unknown as typeof fetch);
    const res = await request('/page-traffic', 'viewer-token');
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe('analytics_reauthorization_required');
  });
});
