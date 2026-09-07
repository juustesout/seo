import { describe, expect, it } from 'vitest';
import { XPublisher } from './xPublisher.js';
import { X_CRED } from './xOAuth.js';

function silentLogger() {
  const noop = () => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop };
}

type FetchCall = { method: string; url: string; body?: unknown };

interface MockXServer {
  fetchFn: typeof fetch;
  calls: FetchCall[];
  refreshCount: () => number;
  tweetCount: () => number;
}

/**
 * Scriptable X API server. `scenario` decides how each endpoint behaves so the
 * tests can cover success, expired-token refresh and the error mapping table.
 */
function mockXServer(scenario: {
  refreshStatus?: number;
  postStatus?: number | 'retry-then-201';
  meStatus?: number;
}): MockXServer {
  const calls: FetchCall[] = [];
  const refreshCount = () => calls.filter((c) => c.url.endsWith('/2/oauth2/token') && String(c.body).includes('refresh_token')).length;
  const tweetCount = () => calls.filter((c) => c.url.endsWith('/2/tweets')).length;

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body instanceof URLSearchParams) {
      body = init.body.toString();
    }
    calls.push({ method, url, body });

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (url.endsWith('/2/oauth2/token')) {
      if (scenario.refreshStatus && scenario.refreshStatus >= 400) {
        return json({ error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' }, scenario.refreshStatus);
      }
      return json({ access_token: 'at-new', refresh_token: 'rt-new', scope: 'tweet.read tweet.write users.read offline.access' });
    }
    if (url.endsWith('/2/users/me?user.fields=name,username')) {
      if (scenario.meStatus && scenario.meStatus >= 400) {
        return json({ title: 'Unauthorized', detail: 'The access token is invalid', status: scenario.meStatus }, scenario.meStatus);
      }
      return json({ data: { id: 'user-1', name: 'Test User', username: 'tester' } });
    }
    if (url.endsWith('/2/tweets')) {
      const status = typeof scenario.postStatus === 'number' ? scenario.postStatus : 201;
      if (status >= 400) {
        const problem =
          status === 403
            ? { title: 'You are not allowed to create a Post with duplicate content.', detail: 'duplicate content', status: 403 }
            : status === 401
              ? { title: 'Unauthorized', detail: 'The access token is invalid or expired', status: 401 }
              : status === 429
                ? { title: 'Too Many Requests', detail: 'rate limited', status: 429 }
                : { title: 'Bad Request', detail: 'bad request', status };
        return json(problem, status);
      }
      return json({ data: { id: 'tweet-1', text: 'ok' } }, 201);
    }
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;

  return { fetchFn, calls, refreshCount, tweetCount };
}

function ctx(config: Record<string, unknown> = {}, tokens: Record<string, string> = {}) {
  const map = new Map(Object.entries(tokens));
  return {
    projectId: 'p1',
    userId: 'u1',
    config,
    credentials: {
      get: async (k: string) => map.get(k) ?? null,
      set: async (k: string, v: string) => void map.set(k, v),
      delete: async (k: string) => void map.delete(k),
    },
    logger: silentLogger(),
    _map: map,
  };
}

function adapter(server: MockXServer) {
  return new XPublisher({ config: { X_OAUTH_CLIENT_ID: 'client-1' }, logger: silentLogger(), fetchFn: server.fetchFn });
}

const input = (content: string) => ({ title: 'Demo', content, contentFormat: 'plain' as const });

describe('X publisher adapter (Content Studio Phase H6.2)', () => {
  it('declares only publish_text + schedule (no article/image/video/update/delete)', () => {
    const a = new XPublisher({ config: {}, logger: silentLogger() });
    expect(a.capabilities).toEqual(['publish_text', 'schedule']);
  });

  it('reports testConnection honestly when no access token is stored', async () => {
    const server = mockXServer({});
    const result = await adapter(server).testConnection(ctx());
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not connected/i);
  });

  it('publishes a real post and derives the target url from the connected handle', async () => {
    const server = mockXServer({});
    const c = ctx({ remote_account_username: 'tester' }, { [X_CRED.access]: 'at-1' });
    const result = await adapter(server).publish(c, input('Hello X'));
    expect(server.tweetCount()).toBe(1);
    expect(result).toEqual({ remoteId: 'tweet-1', url: 'https://x.com/tester/status/tweet-1' });
  });

  it('returns a null url (not a fabricated one) when no handle is stored yet', async () => {
    const server = mockXServer({});
    const c = ctx({}, { [X_CRED.access]: 'at-1' });
    const result = await adapter(server).publish(c, input('Hello X'));
    expect(result.remoteId).toBe('tweet-1');
    expect(result.url).toBeNull();
  });

  it('fails with auth_failed (no retry) when no tokens exist for a publish', async () => {
    const server = mockXServer({});
    await expect(adapter(server).publish(ctx(), input('Hello X'))).rejects.toMatchObject({
      code: 'publisher_auth_failed',
      retryable: false,
    });
    expect(server.tweetCount()).toBe(0);
  });

  it('refreshes ONCE on a 401 and retries the post exactly once', async () => {
    const server = mockXServer({});
    const c = ctx({ remote_account_username: 'tester' }, { [X_CRED.access]: 'at-expired', [X_CRED.refresh]: 'rt-1' });
    // First tweet attempt 401s; refresh returns fresh tokens; second attempt succeeds.
    const orig = server.fetchFn;
    let attempt = 0;
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/2/tweets')) {
        attempt += 1;
        if (attempt === 1) {
          return new Response(JSON.stringify({ title: 'Unauthorized', detail: 'expired', status: 401 }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      return orig(input, init);
    }) as typeof fetch;
    const result = await new XPublisher({ config: { X_OAUTH_CLIENT_ID: 'client-1' }, logger: silentLogger(), fetchFn: stub }).publish(
      c,
      input('Hello X'),
    );
    expect(attempt).toBe(2);
    expect(server.refreshCount()).toBe(1);
    expect(c._map.get(X_CRED.access)).toBe('at-new');
    expect(result).toEqual({ remoteId: 'tweet-1', url: 'https://x.com/tester/status/tweet-1' });
  });

  it('does not retry when the refresh itself fails (stale/rotated refresh token)', async () => {
    const server = mockXServer({ refreshStatus: 400 });
    const c = ctx({}, { [X_CRED.access]: 'at-expired', [X_CRED.refresh]: 'rt-stale' });
    const orig = server.fetchFn;
    let attempts = 0;
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/2/tweets')) {
        attempts += 1;
        return new Response(JSON.stringify({ title: 'Unauthorized', detail: 'expired', status: 401 }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return orig(input, init);
    }) as typeof fetch;
    await expect(
      new XPublisher({ config: { X_OAUTH_CLIENT_ID: 'client-1' }, logger: silentLogger(), fetchFn: stub }).publish(c, input('Hello X')),
    ).rejects.toMatchObject({ code: 'publisher_auth_failed', retryable: false });
    expect(server.refreshCount()).toBe(1);
    expect(attempts).toBe(1);
  });

  it('maps rate limiting to publisher_rate_limited with retry', async () => {
    const server = mockXServer({ postStatus: 429 });
    const c = ctx({}, { [X_CRED.access]: 'at-1' });
    await expect(adapter(server).publish(c, input('Hello X'))).rejects.toMatchObject({
      code: 'publisher_rate_limited',
      retryable: true,
    });
  });

  it('maps duplicate-content 403 to publisher_rejected_content (no retry)', async () => {
    const server = mockXServer({ postStatus: 403 });
    const c = ctx({}, { [X_CRED.access]: 'at-1' });
    await expect(adapter(server).publish(c, input('Hello X'))).rejects.toMatchObject({
      code: 'publisher_rejected_content',
      retryable: false,
    });
  });

  it('refuses content over 280 characters locally before any remote call', async () => {
    const server = mockXServer({});
    const c = ctx({}, { [X_CRED.access]: 'at-1' });
    const long = 'a'.repeat(281);
    await expect(adapter(server).publish(c, input(long))).rejects.toMatchObject({
      code: 'publisher_rejected_content',
    });
    expect(server.tweetCount()).toBe(0);
  });

  it('counts long URLs as t.co width (23) instead of their raw length', async () => {
    const server = mockXServer({});
    const c = ctx({}, { [X_CRED.access]: 'at-1' });
    const url = `https://example.com/${'x'.repeat(120)}`;
    // ~250 visible chars + one long URL (~144 raw) => counts ~273, under 280.
    const text = `${'a'.repeat(250)} ${url}`;
    await expect(adapter(server).publish(c, input(text))).resolves.toMatchObject({ remoteId: 'tweet-1' });
    // Over the limit when the URL were counted raw: ~394 raw chars would reject.
    const longText = `${'a'.repeat(360)} ${url}`;
    await expect(adapter(server).publish(c, input(longText))).rejects.toMatchObject({ code: 'publisher_rejected_content' });
  });

  it('keeps update/delete honest not_available (out of scope)', async () => {
    const server = mockXServer({});
    const a = adapter(server);
    await expect(a.update(ctx(), 'tweet-1', input('x'))).rejects.toMatchObject({ code: 'publisher_not_available', retryable: false });
    await expect(a.delete(ctx(), 'tweet-1')).rejects.toMatchObject({ code: 'publisher_not_available', retryable: false });
    expect(server.tweetCount()).toBe(0);
  });

  it('connect reports the connected handle via a real /users/me round-trip', async () => {
    const server = mockXServer({});
    const c = ctx({}, { [X_CRED.access]: 'at-1' });
    const result = await adapter(server).connect(c);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('@tester');
    expect(result.external?.[0]).toMatchObject({ id: 'user-1', url: 'https://x.com/tester' });
  });
});
