/**
 * GSC HTTP client request seam (R5.10.5).
 *
 * `GscApiClient.request()` is the single place one actual Search Console API
 * request is reported. These tests pin: exactly one report per HTTP request,
 * success/failure classification, error preservation, and that a broken
 * observer can never fail the request.
 */
import { describe, expect, it, vi } from 'vitest';
import { GscApiClient, UnauthorizedError, type GscRequestObserver } from './gscApi.js';

function response(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function client(fetchFn: (url: string, init?: RequestInit) => Promise<Response>, observe?: GscRequestObserver) {
  return new GscApiClient('token', fetchFn as unknown as typeof fetch, observe);
}

describe('GscApiClient request usage', () => {
  it('reports one success for listSites', async () => {
    const calls: Array<[string, boolean]> = [];
    const api = client(async () => response({ siteEntry: [{ siteUrl: 'https://a/', permissionLevel: 'siteOwner' }] }), async (op, ok) => {
      calls.push([op, ok]);
    });
    const sites = await api.listSites();
    expect(sites).toHaveLength(1);
    expect(calls).toEqual([['list_sites', true]]);
  });

  it('reports one success for searchAnalytics', async () => {
    const calls: Array<[string, boolean]> = [];
    const api = client(async () => response({ rows: [{ keys: ['2026-01-01'], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }] }), async (op, ok) => {
      calls.push([op, ok]);
    });
    const res = await api.searchAnalytics('https://a/', { startDate: '2026-01-01', endDate: '2026-01-01' });
    expect(res.rows).toHaveLength(1);
    expect(calls).toEqual([['search_analytics', true]]);
  });

  it('reports failure and preserves UnauthorizedError on 401', async () => {
    const calls: Array<[string, boolean]> = [];
    const api = client(async () => response({ error: 'unauthorized' }, 401), async (op, ok) => {
      calls.push([op, ok]);
    });
    await expect(api.listSites()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toEqual([['list_sites', false]]);
  });

  it('reports failure and preserves the provider error on non-2xx', async () => {
    const calls: Array<[string, boolean]> = [];
    const api = client(async () => response({ error: 'boom' }, 500), async (op, ok) => {
      calls.push([op, ok]);
    });
    await expect(api.listSites()).rejects.toThrow('Search Console API 500');
    expect(calls).toEqual([['list_sites', false]]);
  });

  it('reports failure and rethrows when fetch itself rejects', async () => {
    const calls: Array<[string, boolean]> = [];
    const err = new Error('network down');
    const api = client(async () => {
      throw err;
    }, async (op, ok) => {
      calls.push([op, ok]);
    });
    await expect(api.listSites()).rejects.toBe(err);
    expect(calls).toEqual([['list_sites', false]]);
  });

  it('never fails the request when the observer rejects', async () => {
    const api = client(async () => response({ siteEntry: [] }), async () => {
      throw new Error('usage down');
    });
    await expect(api.listSites()).resolves.toEqual([]);
  });

  it('works without an observer', async () => {
    const api = client(async () => response({ siteEntry: [] }));
    await expect(api.listSites()).resolves.toEqual([]);
  });
});
