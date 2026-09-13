import { describe, expect, it } from 'vitest';
import type { ProviderDeps, ProviderLogger } from '@seo/contracts';
import { createKnowledgeReranker } from './reranker.js';

const logger: ProviderLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function deps(config: Record<string, string | undefined>): ProviderDeps {
  return { config, logger };
}

describe('createKnowledgeReranker (KB10.3)', () => {
  it('returns the explicit no-op reranker when none is configured', () => {
    expect(createKnowledgeReranker(deps({})).id).toBe('none');
    expect(createKnowledgeReranker(deps({ KNOWLEDGE_RERANKER_PROVIDER: 'none' })).isConfigured()).toBe(false);
  });

  it('builds the selected provider', () => {
    const reranker = createKnowledgeReranker(
      deps({ KNOWLEDGE_RERANKER_PROVIDER: 'cohere', KNOWLEDGE_RERANKER_API_KEY: 'secret' }),
    );
    expect(reranker.id).toBe('cohere');
    expect(reranker.isConfigured()).toBe(true);
  });

  it('colapses an unknown provider to the honest no-op', () => {
    expect(createKnowledgeReranker(deps({ KNOWLEDGE_RERANKER_PROVIDER: 'bogus' })).id).toBe('none');
  });

  it('reports a selected provider without credentials as unconfigured', () => {
    const reranker = createKnowledgeReranker(deps({ KNOWLEDGE_RERANKER_PROVIDER: 'cohere' }));
    expect(reranker.id).toBe('cohere');
    expect(reranker.isConfigured()).toBe(false);
  });
});
