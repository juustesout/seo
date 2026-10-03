/**
 * Google Ads OAuth callback tests (P5). The callback is unauthenticated (the
 * browser lands here from Google), so these tests pin: signed-state
 * verification, the account/integration scope check, encrypted token storage
 * under the 'ads' integration, the sealed Google identity and the redirect back
 * into the app. The GSC and GA4 callbacks keep their own paths and behavior.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorHandler } from '../../apiErrors.js';
import { oauthRouter } from './oauth.js';
import { signState } from '../../providers/gsc/oauth.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'test-key';

let currentStores: Store = {};
let storedCreds: Array<[string, string, unknown]> = [];
let updates: Array<{ id: string; patch: Row }> = [];

const realFetch = globalThis.fetch;

function response(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

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
        maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
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

function installGoogleStub() {
  vi.stubGlobal('fetch', (async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return response({ access_token: 'access-1', refresh_token: 'refresh-1', scope: 'adwords', expires_in: 3600 });
    }
    if (String(url).includes('userinfo')) return response({ email: 'user@example.com' });
    return response({}, 404);
  }) as unknown as typeof fetch);
}

async function callback(query: string) {
  const res = await realFetch(`${base}/ads/callback${query}`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') };
}

beforeEach(() => {
  currentStores = {
    seo_integrations: [
      { id: 'int-ads', account_id: ACCOUNT, project_id: null, provider_type: 'ads', status: 'connecting', config: {} },
    ],
  };
  storedCreds = [];
  updates = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/oauth/ads/callback', () => {
  beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { container: unknown }).container = {
        config: {
          publicAppUrl: 'https://app.example.com',
          env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', CREDENTIALS_ENCRYPTION_KEY: KEY },
        },
        sb: fakeSb(),
        credentials: {
          reader: () => ({
            get: async () => null,
            set: async (key: string, value: string, meta?: unknown) => {
              storedCreds.push([key, value, meta]);
            },
            delete: async () => undefined,
          }),
        },
      };
      next();
    });
    app.use('/api/oauth', oauthRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oauth`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects a missing code or state', async () => {
    const res = await realFetch(`${base}/ads/callback`);
    expect(res.status).toBe(400);
  });

  it('rejects a forged state', async () => {
    const res = await realFetch(`${base}/ads/callback?code=abc&state=not-a-signed-state`);
    expect(res.status).toBe(403);
  });

  it('stores tokens, seals the identity and redirects back on success', async () => {
    installGoogleStub();
    const state = signState({ accountId: ACCOUNT, integrationId: 'int-ads', userId: 'user-1', nonce: 'n1' }, KEY);
    const res = await callback(`?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    expect(res.location).toBe('https://app.example.com/integrations?ads=connected');
    expect(storedCreds.map((c) => c[0])).toEqual(expect.arrayContaining(['google_access_token', 'google_refresh_token']));
    expect(storedCreds.find((c) => c[0] === 'google_access_token')?.[1]).toBe('access-1');
    expect(updates[0]).toMatchObject({ id: 'int-ads', patch: { status: 'connected', config: { google_email: 'user@example.com' } } });
  });

  it('does not attach tokens to an integration owned by another account', async () => {
    installGoogleStub();
    const state = signState({ accountId: OTHER_ACCOUNT, integrationId: 'int-ads', userId: 'user-1', nonce: 'n2' }, KEY);
    const res = await callback(`?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(404);
    expect(storedCreds).toHaveLength(0);
  });

  it('redirects with an error code when Google reports a consent failure', async () => {
    const res = await callback('?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.location).toBe('https://app.example.com/integrations?ads_error=access_denied');
  });
});
