/**
 * Account GA4 connect route tests (P4). Verify the authorization URL requests
 * only the read-only Analytics scope (never the GSC write/webmasters scope),
 * targets the dedicated GA4 callback, reuses an existing account integration,
 * and that disconnect clears the GA4 tokens and marks the row disconnected.
 * The GSC account routes are untouched by these tests.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { errorHandler } from '../../apiErrors.js';
import { accountRouter } from './account.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'user-1';

let currentStores: Store = {};
let deletedCredentials: string[] = [];
let inserts: Row[] = [];
let updates: Array<{ id: string; patch: Row }> = [];

const realFetch = globalThis.fetch;

function fakeSb() {
  return {
    from(table: string) {
      const state: { filters: Array<(r: Row) => boolean> } = { filters: [] };
      const apply = () => (currentStores[table] ?? []).filter((x) => state.filters.every((f) => f(x)));
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
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
        insert: (row: Row) => {
          const full = { ...row, id: `int-${inserts.length + 1}` };
          inserts.push(full);
          currentStores[table] = [...(currentStores[table] ?? []), full];
          return { select: () => builder };
        },
        update: (patch: Row) => {
          const target = apply()[0];
          if (target) updates.push({ id: String(target.id), patch });
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
      return builder;
    },
  };
}

let server: Server;
let base = '';

async function request(path: string, method = 'GET') {
  const res = await realFetch(`${base}${path}`, { method });
  return { status: res.status, json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } } };
}

function installContainer(app: express.Express, opts: { googleConfigured?: boolean; unauthenticated?: boolean } = {}) {
  app.use((req, _res, next) => {
    (req as unknown as { container: unknown }).container = {
      access: { requireAccount: async () => ({ account_id: ACCOUNT }) },
      sb: fakeSb(),
      credentials: {
        reader: () => ({
          get: async () => null,
          set: async () => undefined,
          delete: async (key: string) => {
            deletedCredentials.push(key);
          },
        }),
      },
      config: {
        googleConfigured: opts.googleConfigured ?? true,
        encryptionConfigured: true,
        publicAppUrl: 'https://app.example.com',
        env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', CREDENTIALS_ENCRYPTION_KEY: 'test-key' },
      },
      registry: { listDataSources: () => [] },
    };
    (req as unknown as { user?: { sub: string } }).user = opts.unauthenticated ? undefined : { sub: USER };
    next();
  });
  app.use('/api/account', accountRouter);
  app.use(errorHandler);
}

describe('account GA4 routes', () => {
  beforeAll(async () => {
    const app = express();
    installContainer(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/account`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(() => {
    currentStores = { seo_integrations: [] };
    deletedCredentials = [];
    inserts = [];
    updates = [];
  });

  it('requests the read-only Analytics scope on a dedicated GA4 callback', async () => {
    const res = await request('/analytics/connect-url');
    expect(res.status).toBe(200);
    const url = new URL((res.json.data as { url: string }).url);
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).toContain('https://www.googleapis.com/auth/analytics.readonly');
    expect(scope).not.toContain('webmasters');
    expect(scope).not.toContain('analytics.edit');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/oauth/ga4/callback');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(inserts[0]).toMatchObject({ provider_type: 'ga4', project_id: null, account_id: ACCOUNT });
  });

  it('reuses an existing account GA4 integration instead of creating another', async () => {
    currentStores.seo_integrations = [{ id: 'existing-ga4', account_id: ACCOUNT, project_id: null, provider_type: 'ga4', status: 'connected' }];
    const res = await request('/analytics/connect-url');
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(0);
  });

  it('fails clearly when Google OAuth is not configured', async () => {
    const app = express();
    installContainer(app, { googleConfigured: false });
    const srv = app.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as AddressInfo).port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/account/analytics/connect-url`);
    expect(res.status).toBe(503);
    await new Promise((r) => srv.close(r));
  });

  it('disconnects GA4 by clearing its tokens and marking the integration disconnected', async () => {
    currentStores.seo_integrations = [{ id: 'int-ga4', account_id: ACCOUNT, project_id: null, provider_type: 'ga4', status: 'connected' }];
    const res = await request('/analytics/disconnect', 'POST');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ ok: true, was_connected: true });
    expect(deletedCredentials).toContain('google_access_token');
    expect(deletedCredentials).toContain('google_refresh_token');
    expect(updates[0]).toMatchObject({ id: 'int-ga4', patch: { status: 'disconnected' } });
  });

  it('reports an honest no-op disconnect when nothing is connected', async () => {
    const res = await request('/analytics/disconnect', 'POST');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ ok: true, was_connected: false });
  });

  it('requires authentication', async () => {
    const app = express();
    installContainer(app, { unauthenticated: true });
    const srv = app.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as AddressInfo).port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/account/analytics/state`);
    expect(res.status).toBe(401);
    await new Promise((r) => srv.close(r));
  });
});

describe('account GA4 state', () => {
  let srv: Server;
  let sbase: string;
  beforeAll(async () => {
    const app = express();
    installContainer(app);
    await new Promise<void>((resolve) => {
      srv = app.listen(0, () => resolve());
    });
    sbase = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/account`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())));
  });

  it('reports connected state with the Google identity', async () => {
    currentStores = {
      seo_integrations: [{ id: 'int-ga4', account_id: ACCOUNT, project_id: null, provider_type: 'ga4', status: 'connected', config: { google_email: 'user@example.com' } }],
    };
    const res = await realFetch(`${sbase}/analytics/state`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      connected: true,
      integration_id: 'int-ga4',
      status: 'connected',
      account_email: 'user@example.com',
      error: null,
    });
  });
});
