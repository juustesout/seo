import { describe, expect, it, vi } from 'vitest';
import type { OAuthTokenResult, ProviderContext, ProviderRegistry, PublisherOAuthConnector } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { signJsonPayload, verifyJsonPayload } from '../infra/signedPayload.js';
import { X_CRED, X_SCOPES } from '../providers/social/xOAuth.js';
import {
  PUBLISHER_ACCOUNT_KEYS,
  publisherOAuthComplete,
  publisherOAuthStart,
} from './publisherOAuthService.js';

const SECRET = 'state-signing-secret';
const BASE = 'https://app.example.com';
const PROJECT = '00000000-0000-0000-0000-0000000000a1';
const PUBLISHER = '00000000-0000-0000-0000-0000000000a2';
const REDIRECT_URI = `${BASE}/api/oauth/publisher/callback`;

interface Row {
  id: string;
  project_id: string;
  provider: string;
  name: string;
  config: Record<string, unknown>;
  status: string;
}

function fakeSb(row: Row | null) {
  const updates: Array<Record<string, unknown>> = [];
  const from = (table: string) => {
    if (table !== 'seo_publishers') throw new Error(`Unexpected table ${table}`);
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: row, error: null }),
          }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        const chain = { eq: () => chain };
        return chain;
      },
    };
  };
  return { from, updates };
}

interface Harness {
  container: ServiceContainer;
  connector: PublisherOAuthConnector & {
    exchangeCode: ReturnType<typeof vi.fn>;
    fetchIdentity: ReturnType<typeof vi.fn>;
  };
  creds: Map<string, string>;
  updates: Array<Record<string, unknown>>;
  key: string;
}

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: PUBLISHER,
    project_id: PROJECT,
    provider: 'x',
    name: 'X',
    config: {},
    status: 'disconnected',
    ...overrides,
  };
}

function makeHarness(opts: { row?: Row | null; connectorConfigured?: boolean; secret?: string | null } = {}): Harness {
  // null disables the signing secret (simulates a missing CREDENTIALS_ENCRYPTION_KEY).
  const secret = opts.secret === null ? undefined : (opts.secret ?? SECRET);
  const sb = fakeSb(opts.row === undefined ? makeRow() : opts.row);
  const creds = new Map<string, string>();
  const connector = {
    providerId: 'x',
    configured: opts.connectorConfigured ?? true,
    scopes: X_SCOPES,
    authorizeUrl: vi.fn((o: { redirectUri: string; state: string; codeChallenge: string }) => {
      return `https://x/oauth2/authorize?redirect_uri=${encodeURIComponent(o.redirectUri)}&state=${encodeURIComponent(o.state)}&challenge=${o.codeChallenge}`;
    }),
    exchangeCode: vi.fn(async (o: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokenResult> => ({
      access_token: `at:${o.code}`,
      refresh_token: `rt:${o.code}`,
      scope: X_SCOPES,
    })),
    saveTokens: async (ctx: ProviderContext, tokens: OAuthTokenResult) => {
      await ctx.credentials.set(X_CRED.access, tokens.access_token);
      if (tokens.refresh_token) await ctx.credentials.set(X_CRED.refresh, tokens.refresh_token);
    },
    fetchIdentity: vi.fn(async (): Promise<{ id: string; name: string; username: string }> => ({
      id: 'user-1',
      name: 'Test User',
      username: 'tester',
    })),
  } as unknown as Harness['connector'];

  const registry = {
    listPublishers: () => [{ id: 'x', name: 'X' }],
    getPublisherOAuth: () => connector,
  } as unknown as ProviderRegistry;

  const container = {
    config: {
      encryptionConfigured: Boolean(secret),
      env: { CREDENTIALS_ENCRYPTION_KEY: secret },
    },
    registry,
    sb,
    credentials: {
      reader: () => ({
        get: async (k: string) => creds.get(k) ?? null,
        set: async (k: string, v: string) => void creds.set(k, v),
        delete: async (k: string) => void creds.delete(k),
      }),
    },
  } as unknown as ServiceContainer;

  return { container, connector, creds, updates: sb.updates, key: secret ?? '' };
}

function signedState(overrides: Partial<Record<string, unknown>> = {}, secret = SECRET): string {
  return signJsonPayload(
    {
      v: 1,
      projectId: PROJECT,
      publisherId: PUBLISHER,
      provider: 'x',
      userId: 'u1',
      nonce: 'n1',
      verifier: 'the-code-verifier',
      ...overrides,
    },
    secret,
  );
}

describe('publisher OAuth start (generic consent entry)', () => {
  it('refuses to start when credential storage is not configured', async () => {
    const h = makeHarness({ secret: null });
    await expect(
      publisherOAuthStart(h.container, { projectId: PROJECT, publisherId: PUBLISHER, userId: 'u1', redirectBase: BASE }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      publisherOAuthStart(h.container, { projectId: PROJECT, publisherId: PUBLISHER, userId: 'u1', redirectBase: BASE }),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('rejects unknown publishers', async () => {
    const h = makeHarness({ row: null });
    await expect(
      publisherOAuthStart(h.container, { projectId: PROJECT, publisherId: PUBLISHER, userId: 'u1', redirectBase: BASE }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects providers whose connector is not configured on the server', async () => {
    const h = makeHarness({ connectorConfigured: false });
    await expect(
      publisherOAuthStart(h.container, { projectId: PROJECT, publisherId: PUBLISHER, userId: 'u1', redirectBase: BASE }),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('returns a consent url whose state carries the code verifier', async () => {
    const h = makeHarness();
    const { url, redirectUri } = await publisherOAuthStart(h.container, {
      projectId: PROJECT,
      publisherId: PUBLISHER,
      userId: 'u1',
      redirectBase: BASE,
    });
    expect(redirectUri).toBe(REDIRECT_URI);
    expect(url).toContain('https://x/oauth2/authorize');
    const qs = new URL(url).searchParams;
    const state = qs.get('state') as string;
    expect(state).toBeTruthy();
    expect(qs.get('challenge')).toBeTruthy();
    // decode the signed state to confirm the verifier is embedded server-side
    const decoded = verifyJsonPayload<Record<string, unknown>>(state, h.key);
    expect(decoded.verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(decoded.projectId).toBe(PROJECT);
    expect(decoded.provider).toBe('x');
  });
});

describe('publisher OAuth complete (browser callback)', () => {
  it('redirects to /p?oauth_error=denied when the user refuses consent', async () => {
    const h = makeHarness();
    const redirect = await publisherOAuthComplete(h.container, { error: 'access_denied', redirectBase: BASE });
    expect(redirect).toBe(`${BASE}/p?oauth_error=denied`);
  });

  it('redirects with invalid_state when the state is tampered or missing', async () => {
    const h = makeHarness();
    const tampered = `${signedState().slice(0, -4)}AAAA`;
    const a = await publisherOAuthComplete(h.container, { code: 'c', state: tampered, redirectBase: BASE });
    expect(a).toBe(`${BASE}/p?oauth_error=invalid_state`);
    const b = await publisherOAuthComplete(h.container, { code: 'c', redirectBase: BASE });
    expect(b).toBe(`${BASE}/p?oauth_error=invalid_state`);
  });

  it('redirects with not_configured when credential storage is missing', async () => {
    const h = makeHarness({ secret: null });
    const state = signedState();
    const redirect = await publisherOAuthComplete(h.container, { code: 'c', state, redirectBase: BASE });
    expect(redirect).toBe(`${BASE}/p?oauth_error=not_configured`);
  });

  it('redirects to the project publishing page when the publisher vanished', async () => {
    const h = makeHarness({ row: null });
    const redirect = await publisherOAuthComplete(h.container, {
      code: 'c',
      state: signedState(),
      redirectBase: BASE,
    });
    expect(redirect).toBe(`${BASE}/p/${PROJECT}/publishing?oauth_error=publisher_missing`);
  });

  it('connects end-to-end: verifies state, exchanges with PKCE, saves tokens and stores the identity', async () => {
    const h = makeHarness();
    const redirect = await publisherOAuthComplete(h.container, {
      code: 'the-code',
      state: signedState({ verifier: 'the-code-verifier' }),
      redirectBase: BASE,
    });
    expect(h.connector.exchangeCode).toHaveBeenCalledWith({
      code: 'the-code',
      redirectUri: REDIRECT_URI,
      codeVerifier: 'the-code-verifier',
    });
    expect(h.creds.get(X_CRED.access)).toBe('at:the-code');
    expect(h.creds.get(X_CRED.refresh)).toBe('rt:the-code');
    expect(h.connector.fetchIdentity).toHaveBeenCalledOnce();
    expect(h.updates).toHaveLength(1);
    const patch = h.updates[0] as { status: string; config: Record<string, unknown> };
    expect(patch.status).toBe('connected');
    expect(patch.config[PUBLISHER_ACCOUNT_KEYS.id]).toBe('user-1');
    expect(patch.config[PUBLISHER_ACCOUNT_KEYS.username]).toBe('tester');
    expect(redirect).toBe(`${BASE}/p/${PROJECT}/publishing?x=connected`);
  });

  it('never stores tokens and redirects with an error when the exchange fails', async () => {
    const h = makeHarness();
    h.connector.exchangeCode.mockRejectedValue(new Error('X said no'));
    const redirect = await publisherOAuthComplete(h.container, {
      code: 'bad-code',
      state: signedState({ verifier: 'verifier' }),
      redirectBase: BASE,
    });
    expect(redirect).toBe(`${BASE}/p/${PROJECT}/publishing?oauth_error=connect_failed`);
    expect(h.creds.size).toBe(0);
    expect(h.connector.fetchIdentity).not.toHaveBeenCalled();
  });
});
