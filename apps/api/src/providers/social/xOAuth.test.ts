import { describe, expect, it } from 'vitest';
import { XApiError, XOAuthClient, XOAuthConnector, xPostCharacterCount } from './xOAuth.js';
import type { ProviderDeps, PublisherOAuthConnector } from '@seo/contracts';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

/** Records the requests the client issues. */
function recordingFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function client(fetchFn: typeof fetch, clientId = 'x-client') {
  return new XOAuthClient(clientId, fetchFn);
}

describe('X OAuth 2.0 client', () => {
  it('builds a PKCE authorize url with S256 and the requested scopes', () => {
    const url = client(fetch).authorizeUrl({
      redirectUri: 'https://app.example.com/api/oauth/publisher/callback',
      state: 'st',
      codeChallenge: 'challenge',
    });
    const qs = new URL(url).searchParams;
    expect(qs.get('response_type')).toBe('code');
    expect(qs.get('client_id')).toBe('x-client');
    expect(qs.get('redirect_uri')).toBe('https://app.example.com/api/oauth/publisher/callback');
    expect(qs.get('code_challenge')).toBe('challenge');
    expect(qs.get('code_challenge_method')).toBe('S256');
    expect(qs.get('state')).toBe('st');
    expect(qs.get('scope')).toContain('tweet.write');
    expect(qs.get('scope')).toContain('offline.access');
  });

  it('throws rather than building a url without a configured client id', () => {
    const unconfigured = new XOAuthClient('');
    expect(unconfigured.configured).toBe(false);
    expect(() =>
      unconfigured.authorizeUrl({ redirectUri: 'https://x/cb', state: 's', codeChallenge: 'c' }),
    ).toThrow(/client id/i);
  });

  it('exchanges an authorization code with the PKCE verifier', async () => {
    const { fetchFn, calls } = recordingFetch(async () =>
      jsonResponse({ access_token: 'at', refresh_token: 'rt', scope: 'tweet.read' }),
    );
    const tokens = await client(fetchFn).exchangeCode({ code: 'the-code', redirectUri: 'https://x/cb', codeVerifier: 'verifier' });
    expect(tokens.access_token).toBe('at');
    expect(tokens.refresh_token).toBe('rt');
    const call = calls[0];
    expect(call.url).toContain('/2/oauth2/token');
    const body = String(call.init?.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=the-code');
    expect(body).toContain('code_verifier=verifier');
    expect(body).toContain('client_id=x-client');
  });

  it('rotates an access token with the refresh grant', async () => {
    const { fetchFn, calls } = recordingFetch(async () => jsonResponse({ access_token: 'at-new' }));
    const tokens = await client(fetchFn).refreshAccessToken('rt-old');
    expect(tokens.access_token).toBe('at-new');
    expect(String(calls[0].init?.body)).toContain('grant_type=refresh_token');
    expect(String(calls[0].init?.body)).toContain('refresh_token=rt-old');
  });

  it('normalizes token endpoint failures as XApiError without leaking the response body', async () => {
    const { fetchFn } = recordingFetch(async () =>
      jsonResponse({ error: 'invalid_grant', error_description: 'grant is bad' }, 400),
    );
    await expect(client(fetchFn).exchangeCode({ code: 'c', redirectUri: 'https://x/cb', codeVerifier: 'v' })).rejects.toMatchObject({
      name: 'XApiError',
      status: 400,
    });
  });

  it('reads the authenticated user from /2/users/me', async () => {
    const { fetchFn, calls } = recordingFetch(async () =>
      jsonResponse({ data: { id: 'user-1', name: 'Ada', username: 'ada' } }),
    );
    const user = await client(fetchFn).fetchAuthenticatedUser('at');
    expect(user).toEqual({ id: 'user-1', name: 'Ada', username: 'ada' });
    expect(calls[0].url).toContain('/2/users/me');
  });

  it('creates a post and returns the real tweet id from a 201', async () => {
    const { fetchFn, calls } = recordingFetch(async () =>
      jsonResponse({ data: { id: 'tweet-9', text: 'hi' } }, 201),
    );
    const tweet = await client(fetchFn).createPost('at', 'hi');
    expect(tweet.id).toBe('tweet-9');
    const call = calls[0];
    expect(call.url).toBe('https://api.x.com/2/tweets');
    expect((call.init?.body as string)).toContain('"text":"hi"');
    // init.headers is the plain object the client passed through
    expect(call.init?.headers as Record<string, string>).toMatchObject({ authorization: 'Bearer at' });
  });

  it('surfaces API errors (e.g. 403 duplicate) as XApiError with the problem title', async () => {
    const { fetchFn } = recordingFetch(async () =>
      jsonResponse({ title: 'You are not allowed to create a Post with duplicate content.', status: 403 }, 403),
    );
    await expect(client(fetchFn).createPost('at', 'dup')).rejects.toBeInstanceOf(XApiError);
    await expect(client(fetchFn).createPost('at', 'dup')).rejects.toMatchObject({ status: 403 });
  });
});

describe('X OAuth connector (registered for the generic publisher flow)', () => {
  function connector(overrides: Partial<ProviderDeps> = {}): PublisherOAuthConnector {
    const deps: ProviderDeps = {
      config: { X_OAUTH_CLIENT_ID: 'x-client' },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      ...overrides,
    };
    return new XOAuthConnector(deps);
  }

  it('reports configured only when a client id is present', () => {
    expect(connector().configured).toBe(true);
    expect(connector({ config: {} }).configured).toBe(false);
  });

  it('delegates authorize/exchange to the underlying PKCE client', async () => {
    const c = connector({
      fetchFn: (async () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    const url = c.authorizeUrl({ redirectUri: 'https://x/cb', state: 's', codeChallenge: 'cc' });
    expect(new URL(url).searchParams.get('code_challenge')).toBe('cc');
    const tokens = await c.exchangeCode({ code: 'code', redirectUri: 'https://x/cb', codeVerifier: 'verifier' });
    expect(tokens.access_token).toBe('at');
  });

  it('saves the token pair into the encrypted credential scope', async () => {
    const seen = new Map<string, string>();
    const c = connector();
    const ctx = {
      projectId: 'p1',
      userId: 'u1',
      config: {},
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      credentials: {
        get: async (k: string) => seen.get(k) ?? null,
        set: async (k: string, v: string) => void seen.set(k, v),
        delete: async () => undefined,
      },
    };
    await c.saveTokens(ctx, { access_token: 'at', refresh_token: 'rt', scope: 'tweet.read' });
    expect(seen.get('x_access_token')).toBe('at');
    expect(seen.get('x_refresh_token')).toBe('rt');
  });
});

describe('X post character counting (conservative, no auto-shortening)', () => {
  it('counts unicode code points (astral-safe)', () => {
    expect(xPostCharacterCount('hello')).toBe(5);
    expect(xPostCharacterCount('hello '.repeat(20).trim())).toBe(119);
    // A single astral emoji is one code point.
    expect(xPostCharacterCount('a\u{1F600}b')).toBe(3);
  });

  it('counts whitespace and newlines like ordinary characters', () => {
    expect(xPostCharacterCount('a\nb\n\nc')).toBe(6);
    expect(xPostCharacterCount('  ')).toBe(2);
  });

  it('counts any http(s) URL as the t.co width (23)', () => {
    const short = 'https://x.com/a';
    const long = `https://example.com/${'y'.repeat(200)}`;
    expect(xPostCharacterCount(short)).toBe(23);
    expect(xPostCharacterCount(long)).toBe(23);
    expect(xPostCharacterCount(`see ${long} now`)).toBe(23 + 8);
  });
});
