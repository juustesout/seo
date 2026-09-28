/**
 * X publishing usage (R5.10.6).
 *
 * Pins the X seam: each real `POST /2/tweets` is one `publish_attempt`; a
 * provider-internal refresh-once produces two facts (the failed 401 request and
 * the retried request); token and identity calls emit nothing; local validation
 * emits nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderContext, ProviderLogger } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import { XOAuthClient } from './xOAuth.js';
import { XPublisher } from './xPublisher.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const JOB = 'job-x-1';
const noopLogger: ProviderLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function response(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function ctx(store: InMemoryUsageEventStore): ProviderContext {
  const occurrences = new Map<string, number>();
  return {
    projectId: PROJECT,
    userId: USER,
    config: {},
    credentials: {
      get: async (key) => (key === 'x_access_token' ? 'access-1' : key === 'x_refresh_token' ? 'refresh-1' : null),
      set: async () => {},
      delete: async () => {},
    },
    logger: noopLogger,
    usage: {
      sink: store as unknown as NonNullable<ProviderContext['usage']>['sink'],
      sourceId: JOB,
      nextOccurrence: (operation) => {
        const next = occurrences.get(operation) ?? 0;
        occurrences.set(operation, next + 1);
        return next;
      },
    },
  } as ProviderContext;
}

function publisher(fetchFn: typeof fetch): XPublisher {
  return new XPublisher({ config: { X_OAUTH_CLIENT_ID: 'client-id' }, logger: noopLogger, fetchFn });
}

describe('XPublisher publishing usage', () => {
  it('records one publish_attempt for a successful post', async () => {
    const store = new InMemoryUsageEventStore();
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith('/2/tweets')) return response({ data: { id: 'tweet-1', text: 'hi' } });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const result = await publisher(fetchFn).publish(ctx(store), { title: 'Hello', content: 'World', status: 'publish' });

    expect(result.remoteId).toBe('tweet-1');
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: 'publishing', provider: 'x', operation: 'publish', unit: 'publish_attempt', success: true, sourceId: JOB });
  });

  it('counts both physical requests of a refresh-once retry', async () => {
    const store = new InMemoryUsageEventStore();
    let tweets = 0;
    const fetchFn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/2/tweets')) {
        tweets += 1;
        return tweets === 1 ? response({ title: 'Unauthorized' }, 401) : response({ data: { id: 'tweet-2', text: 'hi' } });
      }
      if (u.endsWith('/2/oauth2/token')) return response({ access_token: 'access-2', refresh_token: 'refresh-2' });
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

    const result = await publisher(fetchFn).publish(ctx(store), { title: 'Hello', content: 'World', status: 'publish' });

    expect(result.remoteId).toBe('tweet-2');
    const events = await store.list({ projectId: PROJECT, limit: 10 });
    expect(events).toHaveLength(2);
    const bySuccess = Object.fromEntries(events.map((e) => [e.success, e]));
    expect(bySuccess.true).toMatchObject({ unit: 'publish_attempt', success: true });
    expect(bySuccess.false).toMatchObject({ unit: 'publish_attempt', success: false });
  });

  it('emits nothing when local validation rejects the payload', async () => {
    const store = new InMemoryUsageEventStore();
    const fetchFn = vi.fn(async () => response({ data: { id: 'tweet-3' } })) as unknown as typeof fetch;

    await expect(
      publisher(fetchFn).publish(ctx(store), { title: 'a'.repeat(300), content: '', status: 'publish' }),
    ).rejects.toMatchObject({ code: 'publisher_rejected_content' });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('emits nothing for update/delete, which never call X', async () => {
    const store = new InMemoryUsageEventStore();
    const fetchFn = vi.fn(async () => response({})) as unknown as typeof fetch;

    await expect(publisher(fetchFn).update(ctx(store), 'tweet-1', { title: 'T', content: 'C' })).rejects.toMatchObject({
      code: 'publisher_not_available',
    });
    await expect(publisher(fetchFn).delete(ctx(store), 'tweet-1')).rejects.toMatchObject({ code: 'publisher_not_available' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });
});

describe('XOAuthClient usage seam', () => {
  it('reports only createPost, never identity calls', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/2/users/me?user.fields=name,username')) return response({ data: { id: 'u1', username: 'me', name: 'Me' } });
      if (u.endsWith('/2/tweets')) return response({ data: { id: 'tweet-9', text: 'hi' } });
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;
    const observations: Array<{ operation: string; success: boolean }> = [];
    const client = new XOAuthClient('client-id', fetchFn, async (operation, success) => {
      observations.push({ operation, success });
    });

    await client.fetchAuthenticatedUser('access-1');
    expect(observations).toHaveLength(0);

    await client.createPost('access-1', 'hi');
    expect(observations).toEqual([{ operation: 'publish', success: true }]);
  });

  it('reports a failed createPost as success=false', async () => {
    const fetchFn = vi.fn(async () => response({ title: 'Forbidden' }, 403)) as unknown as typeof fetch;
    const observations: Array<{ operation: string; success: boolean }> = [];
    const client = new XOAuthClient('client-id', fetchFn, async (operation, success) => {
      observations.push({ operation, success });
    });

    await expect(client.createPost('access-1', 'hi')).rejects.toMatchObject({ status: 403 });
    expect(observations).toEqual([{ operation: 'publish', success: false }]);
  });
});
