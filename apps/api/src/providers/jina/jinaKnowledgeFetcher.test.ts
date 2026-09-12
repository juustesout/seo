import { describe, expect, it, vi } from 'vitest';
import { JinaKnowledgeFetcher } from './jinaKnowledgeFetcher.js';
import { KnowledgeIngestError } from '../../knowledge/errors.js';
import { MAX_FETCHED_CHARS } from '../../knowledge/limits.js';

const KEY = 'jina-secret-key';

function recordingFetch(init: { status?: number; body?: string; contentType?: string } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const { status = 200, body = '', contentType = 'application/json' } = init;
  const fetchFn = (async (url: Parameters<typeof fetch>[0], opts?: RequestInit) => {
    calls.push({ url: String(url), init: opts });
    return new Response(body, { status, headers: { 'content-type': contentType } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function expectCode(err: unknown, code: string): void {
  expect(err).toBeInstanceOf(KnowledgeIngestError);
  expect((err as KnowledgeIngestError).code).toBe(code);
}

describe('JinaKnowledgeFetcher', () => {
  it('reports unconfigured without a key and refuses to fetch', async () => {
    const fetcher = new JinaKnowledgeFetcher({ config: {} });
    expect(fetcher.isConfigured()).toBe(false);
    await expect(fetcher.fetch('https://example.com/a')).rejects.toSatisfy((err: unknown) => {
      expectCode(err, 'knowledge_jina_not_configured');
      return true;
    });
  });

  it('is configured when JINA_API_KEY is set and parses the JSON envelope', async () => {
    const { fetchFn, calls } = recordingFetch({
      body: JSON.stringify({ data: { content: 'Extracted body', title: 'A title', url: 'https://example.com/canonical' } }),
    });
    const fetcher = new JinaKnowledgeFetcher({ config: { JINA_API_KEY: KEY }, fetchFn });
    expect(fetcher.isConfigured()).toBe(true);

    const doc = await fetcher.fetch('https://example.com/a');

    expect(doc.contentText).toBe('Extracted body');
    expect(doc.title).toBe('A title');
    expect(doc.canonicalUrl).toBe('https://example.com/canonical');
    expect(doc.sourceUrl).toBe('https://example.com/a');
    expect(calls[0].url).toBe('https://r.jina.ai/https://example.com/a');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('accepts a plain-text/markdown body and honors a custom base URL', async () => {
    const { fetchFn, calls } = recordingFetch({ body: '# Markdown body', contentType: 'text/plain' });
    const fetcher = new JinaKnowledgeFetcher({ config: { JINA_API_KEY: KEY, JINA_BASE_URL: 'https://reader.example/' }, fetchFn });
    const doc = await fetcher.fetch('https://example.com/a');
    expect(doc.contentText).toBe('# Markdown body');
    expect(calls[0].url).toBe('https://reader.example/https://example.com/a');
  });

  it('rejects an empty extraction', async () => {
    const { fetchFn } = recordingFetch({ body: JSON.stringify({ data: { content: '   ' } }) });
    const fetcher = new JinaKnowledgeFetcher({ config: { JINA_API_KEY: KEY }, fetchFn });
    await expect(fetcher.fetch('https://example.com/a')).rejects.toSatisfy((err: unknown) => {
      expectCode(err, 'knowledge_empty_content');
      return true;
    });
  });

  it('rejects an over-limit extraction', async () => {
    const { fetchFn } = recordingFetch({ body: 'x'.repeat(MAX_FETCHED_CHARS + 1), contentType: 'text/plain' });
    const fetcher = new JinaKnowledgeFetcher({ config: { JINA_API_KEY: KEY }, fetchFn });
    await expect(fetcher.fetch('https://example.com/a')).rejects.toSatisfy((err: unknown) => {
      expectCode(err, 'knowledge_source_too_large');
      return true;
    });
  });

  it('rejects an invalid target URL before calling the provider', async () => {
    const fetchFn = vi.fn();
    const fetcher = new JinaKnowledgeFetcher({ config: { JINA_API_KEY: KEY }, fetchFn: fetchFn as unknown as typeof fetch });
    await expect(fetcher.fetch('http://127.0.0.1/x')).rejects.toSatisfy((err: unknown) => {
      expectCode(err, 'knowledge_invalid_url');
      return true;
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('normalizes HTTP status failures', async () => {
    const cases: Array<[number, string]> = [
      [429, 'knowledge_fetch_rate_limited'],
      [404, 'knowledge_fetch_4xx'],
      [500, 'knowledge_fetch_5xx'],
      [302, 'knowledge_fetch_provider_error'],
    ];
    for (const [status, code] of cases) {
      const { fetchFn } = recordingFetch({ status, body: 'error' });
      const fetcher = new JinaKnowledgeFetcher({ config: { JINA_API_KEY: KEY }, fetchFn });
      await expect(fetcher.fetch('https://example.com/a')).rejects.toSatisfy((err: unknown) => {
        expectCode(err, code);
        return true;
      });
    }
  });

  it('maps an abort/timeout to knowledge_fetch_timeout', async () => {
    const fetchFn = (async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as typeof fetch;
    const fetcher = new JinaKnowledgeFetcher({ config: { JINA_API_KEY: KEY }, fetchFn });
    await expect(fetcher.fetch('https://example.com/a')).rejects.toSatisfy((err: unknown) => {
      expectCode(err, 'knowledge_fetch_timeout');
      return true;
    });
  });

  it('maps a transport error to a provider error without leaking the key', async () => {
    const fetchFn = (async () => {
      throw new Error(`network blew up talking to ${KEY}`);
    }) as typeof fetch;
    const fetcher = new JinaKnowledgeFetcher({ config: { JINA_API_KEY: KEY }, fetchFn });
    await expect(fetcher.fetch('https://example.com/a')).rejects.toSatisfy((err: unknown) => {
      expectCode(err, 'knowledge_fetch_provider_error');
      expect((err as Error).message).not.toContain(KEY);
      return true;
    });
  });
});
