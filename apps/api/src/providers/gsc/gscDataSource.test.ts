/**
 * GSC adapter request accounting (R5.10.5).
 *
 * Exercises the adapter end of the request seam: weekly chunking counts each
 * real request, the 401 refresh produces two request facts while the token
 * endpoint produces none, local failures before fetch produce none, and an
 * account-scoped context with no real project emits nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderContext, ProviderLogger } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import { GscDataSource } from './gscDataSource.js';

vi.mock('../../util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../util.js')>();
  return { ...actual, delay: async () => {} };
});

const PROJECT = '11111111-1111-4111-8111-111111111111';
const JOB = 'job-r5-105';
const SITE = 'https://example.com/';
const noopLogger: ProviderLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function response(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function adapter() {
  return new GscDataSource({ config: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret' }, logger: noopLogger });
}

function context(
  store: InMemoryUsageEventStore | null,
  overrides: Partial<ProviderContext> = {},
): ProviderContext {
  const occurrences = new Map<string, number>();
  return {
    projectId: PROJECT,
    userId: null,
    config: { siteUrl: SITE },
    credentials: {
      get: async (key) =>
        key === 'google_access_token' ? 'access-token' : key === 'google_refresh_token' ? 'refresh-token' : null,
      set: async () => {},
      delete: async () => {},
    },
    logger: noopLogger,
    ...(store
      ? {
          usage: {
            sink: store,
            sourceId: JOB,
            nextOccurrence: (operation: string) => {
              const next = occurrences.get(operation) ?? 0;
              occurrences.set(operation, next + 1);
              return next;
            },
          },
        }
      : {}),
    ...overrides,
  };
}

function emptySearchAnalytics() {
  return response({ rows: [] });
}

describe('GscDataSource usage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports one search_analytics fact for fetchDaily', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => emptySearchAnalytics()));
    const rows = await adapter().fetchDaily(context(store), { startDate: '2026-01-01', endDate: '2026-01-28' });
    expect(rows).toEqual([]);
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: 'gsc', unit: 'gsc_request', operation: 'search_analytics', sourceId: JOB, success: true });
  });

  it('reports one fact per weekly chunk for fetchDimension', async () => {
    const store = new InMemoryUsageEventStore();
    const fetchMock = vi.fn(async () => emptySearchAnalytics());
    vi.stubGlobal('fetch', fetchMock);
    await adapter().fetchDimension(context(store), { startDate: '2026-01-01', endDate: '2026-01-28' }, ['date', 'query']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.sourceId === JOB && e.operation === 'search_analytics')).toBe(true);
  });

  it('reports one list_sites fact for listProperties', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => response({ siteEntry: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }] })));
    const props = await adapter().listProperties(context(store));
    expect(props).toEqual([{ siteUrl: SITE, permissionLevel: 'siteOwner' }]);
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'list_sites', success: true });
  });

  it('emits nothing when tokens are missing before any request', async () => {
    const store = new InMemoryUsageEventStore();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      adapter().listProperties(
        context(store, { credentials: { get: async () => null, set: async () => {}, delete: async () => {} } }),
      ),
    ).rejects.toThrow('missing OAuth tokens');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('does not fabricate a project fact for an account-scoped context', async () => {
    const store = new InMemoryUsageEventStore();
    const fetchMock = vi.fn(async () => response({ siteEntry: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await adapter().listProperties(context(store, { projectId: '' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('counts both real requests of a 401-refresh-retry but not the token call', async () => {
    const store = new InMemoryUsageEventStore();
    let gsc = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return response({ access_token: 'refreshed-token', expires_in: 3600 });
      }
      gsc += 1;
      return gsc === 1 ? response({ error: 'expired' }, 401) : response({ siteEntry: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await adapter().listProperties(context(store));
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
    expect(events.filter((e) => e.success).length).toBe(1);
    expect(events.filter((e) => !e.success).length).toBe(1);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('oauth2.googleapis.com/token'))).toBe(true);
  });

  it('still works when no usage context is supplied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ siteEntry: [] })));
    await expect(adapter().listProperties(context(null))).resolves.toEqual([]);
  });
});

describe('GscDataSource timing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => emptySearchAnalytics()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paces calls without affecting facts', async () => {
    const store = new InMemoryUsageEventStore();
    await adapter().fetchDimension(context(store), { startDate: '2026-01-01', endDate: '2026-01-07' }, ['date', 'page']);
    expect(await store.list({ projectId: PROJECT })).toHaveLength(1);
  });
});
