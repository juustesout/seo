/**
 * Account Google Ads connect route tests (P5). Verify the authorization URL
 * requests the Google Ads scope, targets the dedicated Ads callback, reuses an
 * existing account integration, and that disconnect clears the Ads tokens and
 * marks the row disconnected. The GSC and GA4 account routes are untouched.
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

describe('account Google Ads routes', () => {
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

  it('requests the Google Ads scope on a dedicated Ads callback', async () => {
    const res = await request('/ads/connect-url');
    expect(res.status).toBe(200);
    const url = new URL((res.json.data as { url: string }).url);
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).toContain('https://www.googleapis.com/auth/adwords');
    expect(scope).not.toContain('webmasters');
    expect(scope).not.toContain('analytics');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/oauth/ads/callback');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(inserts[0]).toMatchObject({ provider_type: 'ads', project_id: null, account_id: ACCOUNT });
  });

  it('reuses an existing account Ads integration instead of creating another', async () => {
    currentStores.seo_integrations = [{ id: 'existing-ads', account_id: ACCOUNT, project_id: null, provider_type: 'ads', status: 'connected' }];
    const res = await request('/ads/connect-url');
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(0);
  });

  it('fails clearly when Google OAuth is not configured', async () => {
    const app = express();
    installContainer(app, { googleConfigured: false });
    const srv = app.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as AddressInfo).port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/account/ads/connect-url`);
    expect(res.status).toBe(503);
    await new Promise((r) => srv.close(r));
  });

  it('disconnects Ads by clearing its tokens and marking the integration disconnected', async () => {
    currentStores.seo_integrations = [{ id: 'int-ads', account_id: ACCOUNT, project_id: null, provider_type: 'ads', status: 'connected' }];
    const res = await request('/ads/disconnect', 'POST');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ ok: true, was_connected: true });
    expect(deletedCredentials).toContain('google_access_token');
    expect(deletedCredentials).toContain('google_refresh_token');
    expect(updates[0]).toMatchObject({ id: 'int-ads', patch: { status: 'disconnected' } });
  });

  it('reports an honest no-op disconnect when nothing is connected', async () => {
    const res = await request('/ads/disconnect', 'POST');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ ok: true, was_connected: false });
  });

  it('requires authentication', async () => {
    const app = express();
    installContainer(app, { unauthenticated: true });
    const srv = app.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as AddressInfo).port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/account/ads/state`);
    expect(res.status).toBe(401);
    await new Promise((r) => srv.close(r));
  });
});

describe('account Google Ads state', () => {
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
      seo_integrations: [{ id: 'int-ads', account_id: ACCOUNT, project_id: null, provider_type: 'ads', status: 'connected', config: { google_email: 'user@example.com' } }],
    };
    const res = await realFetch(`${sbase}/ads/state`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      connected: true,
      integration_id: 'int-ads',
      status: 'connected',
      account_email: 'user@example.com',
      error: null,
    });
  });
});
