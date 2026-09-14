/**
 * DataForSEO client competitor endpoints (KW3). Verifies the exact request
 * bodies: the Labs paths, the gap's `intersections: false` and the provider-side
 * `filters` (ranking and volume conditions joined with `and`) plus `item_types`
 * so the vendor trims rows before we ever store them.
 */
import { describe, expect, it } from 'vitest';
import { DataForSeoClient } from './dataForSeoClient.js';

interface CapturedCall {
  url: string;
  body: Array<Record<string, unknown>> | null;
}

function clientWith(calls: CapturedCall[], response: unknown): DataForSeoClient {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: true, status: 200, json: async () => response } as unknown as Response;
  }) as unknown as typeof fetch;
  return new DataForSeoClient({ basicToken: 'test' }, { ratePerMinute: 0, fetchFn });
}

describe('DataForSeoClient.competitorDomains', () => {
  it('posts one Labs task with the target and candidate cap', async () => {
    const calls: CapturedCall[] = [];
    const items = [{ domain: 'rival.com', intersections: 10 }];
    const client = clientWith(calls, { status_code: 20000, tasks: [{ result: [{ items }] }] });

    const out = await client.competitorDomains('example.com', { limit: 20 });

    expect(calls[0].url).toContain('/v3/dataforseo_labs/google/competitors_domain/live');
    expect(calls[0].body?.[0]).toMatchObject({ target: 'example.com', limit: 20, exclude_top_domains: true });
    expect(out).toEqual(items);
  });

  it('returns an empty list when the vendor sends no items', async () => {
    const calls: CapturedCall[] = [];
    const client = clientWith(calls, { status_code: 20000, tasks: [] });
    expect(await client.competitorDomains('example.com')).toEqual([]);
  });
});

describe('DataForSeoClient.domainIntersection', () => {
  it('requests target1-only keywords and pushes rank and volume constraints vendor-side', async () => {
    const calls: CapturedCall[] = [];
    const client = clientWith(calls, { status_code: 20000, tasks: [{ result: [{ items: [{ keyword_data: {} }] }] }] });

    await client.domainIntersection('rival.com', 'example.com', {
      maxRankGroup: 10,
      minSearchVolume: 50,
      limit: 200,
    });

    expect(calls[0].url).toContain('/v3/dataforseo_labs/google/domain_intersection/live');
    const body = calls[0].body?.[0] ?? {};
    expect(body).toMatchObject({
      target1: 'rival.com',
      target2: 'example.com',
      intersections: false,
      item_types: ['organic'],
      limit: 200,
    });
    expect(body.filters).toEqual([
      ['first_domain_serp_element.rank_group', '<=', 10],
      'and',
      ['keyword_data.keyword_info.search_volume', '>=', 50],
    ]);
  });

  it('omits filters when no constraints are requested and honors excludePaid=false', async () => {
    const calls: CapturedCall[] = [];
    const client = clientWith(calls, { status_code: 20000, tasks: [{ result: [{ items: [] }] }] });

    await client.domainIntersection('rival.com', 'example.com', { excludePaid: false });

    expect(calls[0].body?.[0].filters).toBeUndefined();
    expect(calls[0].body?.[0].item_types).toEqual(['organic', 'paid']);
  });
});
