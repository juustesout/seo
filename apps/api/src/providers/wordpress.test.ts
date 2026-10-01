/**
 * WordPress publishing usage (R5.10.6).
 *
 * Pins the WordPress seam: one real create/update/delete request -> one
 * `publish_attempt`; a remote rejection or transport failure after the request
 * -> `success=false` with the original WordPressError preserved; `whoami` and
 * pre-request failures emit nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderContext, ProviderLogger } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../services/usageEventRepository.js';
import { WordPressError, WordPressPublisher } from './wordpress.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const JOB = 'job-wp-1';
const noopLogger: ProviderLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function response(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function ctx(
  store: InMemoryUsageEventStore,
  opts: { config?: ProviderContext['config']; credentials?: Record<string, string> } = {},
): ProviderContext {
  const occurrences = new Map<string, number>();
  const creds: Record<string, string> = opts.credentials ?? {
    wordpress_username: 'admin',
    wordpress_application_password: 'app-pass',
  };
  return {
    projectId: PROJECT,
    userId: USER,
    config: opts.config ?? { base_url: 'https://blog.example.com' },
    credentials: {
      get: async (key: string) => creds[key] ?? null,
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

function publisher(): WordPressPublisher {
  return new WordPressPublisher({ config: {}, logger: noopLogger });
}

const input = { title: 'T', content: '<p>C</p>', status: 'publish' as const };

describe('WordPress publishing usage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('records one publish_attempt for a successful create', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => response({ id: 42, link: 'https://blog.example.com/?p=42' }, 201)));

    const result = await publisher().publish(ctx(store), input);

    expect(result).toEqual({ remoteId: '42', url: 'https://blog.example.com/?p=42' });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'publishing',
      provider: 'wordpress',
      operation: 'publish',
      unit: 'publish_attempt',
      quantity: 1,
      success: true,
      sourceId: JOB,
      userId: USER,
    });
  });

  it('records one publish_attempt for a successful update', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => response({ id: 42, link: 'https://blog.example.com/?p=42' })));

    await publisher().update(ctx(store), '42', input);

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'publish_update', unit: 'publish_attempt', success: true });
  });

  it('records one publish_attempt for a successful delete', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => response({ deleted: true })));

    await publisher().delete(ctx(store), '42');

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'publish_delete', unit: 'publish_attempt', success: true });
  });

  it('records a failed attempt and preserves the WordPressError on remote rejection', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => response({ message: 'not allowed' }, 403)));

    await expect(publisher().publish(ctx(store), input)).rejects.toBeInstanceOf(WordPressError);

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'publish', unit: 'publish_attempt', success: false });
  });

  it('records a failed attempt when the transport throws', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('socket hang up');
    }));

    await expect(publisher().publish(ctx(store), input)).rejects.toThrow('socket hang up');

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ success: false, unit: 'publish_attempt' });
  });

  it('emits nothing for whoami (testConnection)', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => response({ id: 1, name: 'Admin' })));

    const result = await publisher().testConnection(ctx(store));

    expect(result.ok).toBe(true);
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('emits nothing when configuration is missing before any request', async () => {
    const store = new InMemoryUsageEventStore();
    const fetchFn = vi.fn(async () => response({ id: 42 }));
    vi.stubGlobal('fetch', fetchFn);
    const c = ctx(store, { config: {} });
    await expect(publisher().publish(c, input)).rejects.toThrow('site URL is not configured');

    expect(fetchFn).not.toHaveBeenCalled();
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('rejects an internal/private site URL before any request (SSRF guard)', async () => {
    const store = new InMemoryUsageEventStore();
    const fetchFn = vi.fn(async () => response({ id: 42 }));
    vi.stubGlobal('fetch', fetchFn);
    const c = ctx(store, { config: { base_url: 'http://169.254.169.254/latest/meta-data' } });
    await expect(publisher().publish(c, input)).rejects.toThrow('public http(s) URL');

    expect(fetchFn).not.toHaveBeenCalled();
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('rejects a non-http(s) scheme before any request', async () => {
    const store = new InMemoryUsageEventStore();
    const fetchFn = vi.fn(async () => response({ id: 42 }));
    vi.stubGlobal('fetch', fetchFn);
    const c = ctx(store, { config: { base_url: 'file:///etc/passwd' } });
    await expect(publisher().publish(c, input)).rejects.toThrow('public http(s) URL');

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
