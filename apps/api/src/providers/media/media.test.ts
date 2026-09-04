import { describe, expect, it } from 'vitest';
import { OpenAiMediaProvider } from './openaiMedia.js';
import { UnsplashMediaProvider } from './unsplash.js';

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
          results: [{ id: 'u1', urls: { regular: 'https://u/reg.jpg', small: 'https://u/sm.jpg' }, width: 4000, height: 3000, alt_description: 'office desk' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const p = new UnsplashMediaProvider(
      { config: { UNSPLASH_ACCESS_KEY: 'k' }, logger: console, fetchFn: fetchFn as never },
    );
    const results = await p.search({ query: 'seo', limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'u1', url: 'https://u/reg.jpg', source: 'unsplash' });
  });
});
