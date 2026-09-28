import { describe, expect, it } from 'vitest';
import type { MediaUsageScope, ProviderUsageContext } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import { OpenAiMediaProvider } from './openaiMedia.js';
import { UnsplashMediaProvider } from './unsplash.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const JOB = 'job-r5-107-media';

function usageScope(
  store: { append: (events: never[]) => unknown },
  sourceId: string | null = JOB,
  base = 0,
): MediaUsageScope {
  const occurrences = new Map<string, number>();
  const usage: ProviderUsageContext = {
    sink: store as unknown as ProviderUsageContext['sink'],
    sourceId,
    nextOccurrence: (operation) => {
      const next = occurrences.get(operation) ?? base;
      occurrences.set(operation, next + 1);
      return next;
    },
  };
  return { projectId: PROJECT, userId: USER, usage };
}

function unsplashResponse(ok = true): Response {
  return new Response(
    JSON.stringify(
      ok
        ? {
            results: [
              {
                id: 'u1',
                urls: { regular: 'https://u/reg.jpg' },
                width: 1,
                height: 1,
                alt_description: 'x',
              },
            ],
          }
        : { errors: ['bad'] },
    ),
    { status: ok ? 200 : 403, headers: { 'content-type': 'application/json' } },
  );
}

describe('OpenAiMediaProvider', () => {
  it('is not configured without an OpenAI key', async () => {
    const p = new OpenAiMediaProvider({ config: {}, logger: console });
    expect(p.isConfigured()).toBe(false);
    await expect(p.generate({ prompt: 'x' })).rejects.toThrow('not configured');
  });

  it('returns the generated image url', async () => {
    const fetchFn = async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ url: 'https://img.example/1.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const p = new OpenAiMediaProvider({
      config: { OPENAI_API_KEY: 'k' },
      logger: console,
      fetchFn: fetchFn as never,
    });
    const r = await p.generate({ prompt: 'a seo illustration' });
    expect(r.url).toBe('https://img.example/1.png');
    expect(r.source).toBe('openai');
  });
});

describe('UnsplashMediaProvider', () => {
  it('is not configured without an access key', () => {
    const p = new UnsplashMediaProvider({ config: {}, logger: console });
    expect(p.isConfigured()).toBe(false);
  });

  it('maps search results', async () => {
    const fetchFn = async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: 'u1',
              urls: { regular: 'https://u/reg.jpg', small: 'https://u/sm.jpg' },
              width: 4000,
              height: 3000,
              alt_description: 'office desk',
              links: { html: 'https://unsplash.com/photos/u1' },
              user: { name: 'Ada', links: { html: 'https://unsplash.com/@ada' } },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const p = new UnsplashMediaProvider(
      { config: { UNSPLASH_ACCESS_KEY: 'k' }, logger: console, fetchFn: fetchFn as never },
    );
    const results = await p.search({ query: 'seo', limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'u1',
      sourceAssetId: 'u1',
      url: 'https://u/reg.jpg',
      source: 'unsplash',
      author: 'Ada',
      authorUrl: 'https://unsplash.com/@ada',
      sourceUrl: 'https://unsplash.com/photos/u1',
    });
  });
});

describe('UnsplashMediaProvider usage instrumentation (R5.10.7)', () => {
  it('records one media/media_search/request fact for one external search', async () => {
    const store = new InMemoryUsageEventStore();
    const p = new UnsplashMediaProvider({
      config: { UNSPLASH_ACCESS_KEY: 'k' },
      logger: console,
      fetchFn: (async () => unsplashResponse()) as never,
    });
    await p.search({ query: 'seo', usage: usageScope(store) });

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'media',
      provider: 'unsplash',
      operation: 'media_search',
      quantity: 1,
      unit: 'request',
      success: true,
      sourceId: JOB,
      userId: USER,
    });
  });

  it('records a failed attempt when the API answers with an error', async () => {
    const store = new InMemoryUsageEventStore();
    const p = new UnsplashMediaProvider({
      config: { UNSPLASH_ACCESS_KEY: 'k' },
      logger: console,
      fetchFn: (async () => unsplashResponse(false)) as never,
    });
    await expect(p.search({ query: 'seo', usage: usageScope(store) })).rejects.toThrow('Unsplash API 403');

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'media_search', success: false });
  });

  it('records a failed attempt when the request cannot complete', async () => {
    const store = new InMemoryUsageEventStore();
    const p = new UnsplashMediaProvider({
      config: { UNSPLASH_ACCESS_KEY: 'k' },
      logger: console,
      fetchFn: (async () => {
        throw new Error('network down');
      }) as never,
    });
    await expect(p.search({ query: 'seo', usage: usageScope(store) })).rejects.toThrow('network down');

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'media_search', success: false });
  });

  it('records nothing when the provider is not configured', async () => {
    const store = new InMemoryUsageEventStore();
    const p = new UnsplashMediaProvider({ config: {}, logger: console });
    await expect(p.search({ query: 'seo', usage: usageScope(store) })).rejects.toThrow('not configured');
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('gives each physical search its own occurrence', async () => {
    const store = new InMemoryUsageEventStore();
    const p = new UnsplashMediaProvider({
      config: { UNSPLASH_ACCESS_KEY: 'k' },
      logger: console,
      fetchFn: (async () => unsplashResponse()) as never,
    });
    const scope = usageScope(store);
    await p.search({ query: 'a', usage: scope });
    await p.search({ query: 'b', usage: scope });

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
  });
});

describe('OpenAiMediaProvider usage instrumentation (R5.10.7)', () => {
  function openaiResponse(body: unknown, ok = true): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status: ok ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
  }

  it('records one media/image_generate/image_generation fact with the applied model', async () => {
    const store = new InMemoryUsageEventStore();
    const p = new OpenAiMediaProvider({
      config: { OPENAI_API_KEY: 'k', OPENAI_IMAGE_MODEL: 'dall-e-3' },
      logger: console,
      fetchFn: openaiResponse({ data: [{ url: 'https://img.example/1.png' }] }),
    });
    await p.generate({ prompt: 'x', usage: usageScope(store) });

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'media',
      provider: 'openai_media',
      operation: 'image_generate',
      quantity: 1,
      unit: 'image_generation',
      success: true,
      sourceId: JOB,
      metadata: { model: 'dall-e-3' },
    });
  });

  it('records a failed attempt when the API answers with an error', async () => {
    const store = new InMemoryUsageEventStore();
    const p = new OpenAiMediaProvider({
      config: { OPENAI_API_KEY: 'k' },
      logger: console,
      fetchFn: openaiResponse({ error: 'nope' }, false),
    });
    await expect(p.generate({ prompt: 'x', usage: usageScope(store) })).rejects.toThrow('OpenAI images API 500');

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'image_generate', success: false });
  });

  it('records a failed attempt when the API returns no image', async () => {
    const store = new InMemoryUsageEventStore();
    const p = new OpenAiMediaProvider({
      config: { OPENAI_API_KEY: 'k' },
      logger: console,
      fetchFn: openaiResponse({ data: [{}] }),
    });
    await expect(p.generate({ prompt: 'x', usage: usageScope(store) })).rejects.toThrow('no image');

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'image_generate', success: false });
  });

  it('records nothing when the provider is not configured', async () => {
    const store = new InMemoryUsageEventStore();
    const p = new OpenAiMediaProvider({ config: {}, logger: console });
    await expect(p.generate({ prompt: 'x', usage: usageScope(store) })).rejects.toThrow('not configured');
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('does not break generation when the usage sink fails', async () => {
    const p = new OpenAiMediaProvider({
      config: { OPENAI_API_KEY: 'k' },
      logger: console,
      fetchFn: openaiResponse({ data: [{ url: 'https://img.example/1.png' }] }),
    });
    const scope = usageScope({
      append: async () => {
        throw new Error('ledger down');
      },
    });
    const result = await p.generate({ prompt: 'x', usage: scope });
    expect(result.url).toBe('https://img.example/1.png');
  });
});
