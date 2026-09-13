/**
 * DataForSEO client expansion endpoints (KW4). Pins the exact Labs paths and
 * request bodies, especially the provider-side volume filters whose field path
 * differs per endpoint (related nests under keyword_data, ideas/suggestions are
 * flat) so a discovery filter truly trims rows before they reach us.
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

describe('DataForSeoClient.relatedKeywords', () => {
  it('posts related_keywords with depth, limit and a nested volume filter', async () => {
    const calls: CapturedCall[] = [];
    const items = [{ keyword_data: { keyword: 'seo tools' } }];
    const client = clientWith(calls, { status_code: 20000, tasks: [{ result: [{ items }] }] });

    const out = await client.relatedKeywords('seo', { depth: 2, limit: 150, minSearchVolume: 50 });

    expect(calls[0].url).toContain('/v3/dataforseo_labs/google/related_keywords/live');
    const body = calls[0].body?.[0] ?? {};
    expect(body).toMatchObject({ keyword: 'seo', depth: 2, limit: 150, include_serp_info: false });
    expect(body.filters).toEqual([['keyword_data.keyword_info.search_volume', '>=', 50]]);
    expect(out).toEqual(items);
  });

  it('defaults depth to 1 and omits filters when no minimum volume is requested', async () => {
    const calls: CapturedCall[] = [];
    const client = clientWith(calls, { status_code: 20000, tasks: [{ result: [{ items: [] }] }] });
    await client.relatedKeywords('seo');
    expect(calls[0].body?.[0]).toMatchObject({ depth: 1, limit: 100 });
    expect(calls[0].body?.[0].filters).toBeUndefined();
  });
});

describe('DataForSeoClient.keywordIdeas', () => {
  it('posts keyword_ideas with the seed list and a flat volume filter', async () => {
    const calls: CapturedCall[] = [];
    const client = clientWith(calls, { status_code: 20000, tasks: [{ result: [{ items: [] }] }] });

    await client.keywordIdeas(['seo', 'seo tools'], { limit: 200, minSearchVolume: 10 });

    expect(calls[0].url).toContain('/v3/dataforseo_labs/google/keyword_ideas/live');
    const body = calls[0].body?.[0] ?? {};
    expect(body).toMatchObject({ keywords: ['seo', 'seo tools'], limit: 200, closely_variants: false, include_serp_info: false });
    expect(body.filters).toEqual([['keyword_info.search_volume', '>=', 10]]);
  });
});

describe('DataForSeoClient.keywordSuggestions (KW4 opts)', () => {
  it('pushes a flat volume filter when a minimum is supplied', async () => {
    const calls: CapturedCall[] = [];
    const client = clientWith(calls, { status_code: 20000, tasks: [{ result: [{ items: [] }] }] });
    await client.keywordSuggestions('seo', { limit: 200, minSearchVolume: 25 });
    expect(calls[0].body?.[0]).toMatchObject({ keyword: 'seo', limit: 200 });
    expect(calls[0].body?.[0].filters).toEqual([['keyword_info.search_volume', '>=', 25]]);
  });

  it('keeps the legacy request shape when called without opts', async () => {
    const calls: CapturedCall[] = [];
    const client = clientWith(calls, { status_code: 20000, tasks: [{ result: [{ items: [] }] }] });
    await client.keywordSuggestions('seo');
    expect(calls[0].body?.[0]).toMatchObject({ keyword: 'seo', limit: 20 });
    expect(calls[0].body?.[0].filters).toBeUndefined();
  });
});
