import { describe, expect, it, vi } from 'vitest';
import type { ProviderDeps, ProviderLogger } from '@seo/contracts';
import { CohereKnowledgeReranker } from './cohereReranker.js';
import { KnowledgeRerankError } from '../../knowledge/retrieval/rerank.js';

const logger: ProviderLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function deps(config: Record<string, string | undefined>, fetchFn: typeof fetch): ProviderDeps {
  return { config, logger, fetchFn };
}

function response(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

const request = {
  query: 'canonical query',
  candidates: [
    { id: 'a::0', content: 'first doc' },
    { id: 'b::0', content: 'second doc' },
  ],
};

describe('CohereKnowledgeReranker (KB10.3)', () => {
  it('reports configured only with a server-side key', () => {
    expect(new CohereKnowledgeReranker(deps({}, vi.fn() as unknown as typeof fetch)).isConfigured()).toBe(false);
    expect(
      new CohereKnowledgeReranker(deps({ KNOWLEDGE_RERANKER_API_KEY: 'secret' }, vi.fn() as unknown as typeof fetch)).isConfigured(),
    ).toBe(true);
  });

  it('sends the query and documents as separate fields with the key server-side', async () => {
    const fetchFn = vi.fn(async () =>
      response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] })),
    );
    const reranker = new CohereKnowledgeReranker(
      deps({ KNOWLEDGE_RERANKER_API_KEY: 'secret', KNOWLEDGE_RERANKER_MODEL: 'rerank-v3.5' }, fetchFn as unknown as typeof fetch),
    );

    const result = await reranker.rerank(request);

    expect(result).toEqual({
      rankings: [
        { id: 'b::0', score: 0.9 },
        { id: 'a::0', score: 0.1 },
      ],
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cohere.com/v1/rerank');
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret' });
    const body = JSON.parse(String(init.body));
    expect(body.query).toBe('canonical query');
    expect(body.documents).toEqual(['first doc', 'second doc']);
    expect(body.model).toBe('rerank-v3.5');
    expect(body.top_n).toBe(2);
  });

  it('maps a provider failure to a safe error without leaking the body or key', async () => {
    const fetchFn = vi.fn(async () => response('internal provider secret', 500));
    const reranker = new CohereKnowledgeReranker(
      deps({ KNOWLEDGE_RERANKER_API_KEY: 'top-secret-key' }, fetchFn as unknown as typeof fetch),
    );

    await expect(reranker.rerank(request)).rejects.toMatchObject({ code: 'provider_error' });
    await reranker.rerank(request).catch((err: KnowledgeRerankError) => {
      expect(err.message).not.toContain('top-secret-key');
      expect(err.message).not.toContain('internal provider secret');
    });
  });

  it('maps a timeout to a safe error', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchFn = vi.fn(async () => {
      throw abortError;
    });
    const reranker = new CohereKnowledgeReranker(
      deps({ KNOWLEDGE_RERANKER_API_KEY: 'secret' }, fetchFn as unknown as typeof fetch),
    );

    await expect(reranker.rerank(request)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects malformed, out-of-range and non-finite results', async () => {
    const cases = [
      'not json',
      JSON.stringify({ results: 'nope' }),
      JSON.stringify({ results: [{ index: 5, relevance_score: 1 }] }),
      JSON.stringify({ results: [{ index: 0, relevance_score: null }] }),
      JSON.stringify({ results: [{ index: 0, relevance_score: Number.NaN }] }),
      JSON.stringify({ results: [{ index: 0.5, relevance_score: 1 }] }),
    ];
    for (const body of cases) {
      const reranker = new CohereKnowledgeReranker(
        deps({ KNOWLEDGE_RERANKER_API_KEY: 'secret' }, (async () => response(body)) as unknown as typeof fetch),
      );
      await expect(reranker.rerank(request)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('does not call the provider when there are no documents', async () => {
    const fetchFn = vi.fn();
    const reranker = new CohereKnowledgeReranker(
      deps({ KNOWLEDGE_RERANKER_API_KEY: 'secret' }, fetchFn as unknown as typeof fetch),
    );
    const result = await reranker.rerank({ query: 'q', candidates: [] });
    expect(result).toEqual({ rankings: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
