/**
 * KnowledgeReranker factory (KB10.3).
 *
 * The single seam that decides which reranking provider backs the optional
 * quality layer. The factory is explicitly honest: when no provider is selected
 * or the selected provider lacks its server-side credentials it returns the
 * no-op reranker, so search keeps the deterministic RRF order with no hidden
 * AI call and no fake scores. Adding a provider means adding a case here and an
 * adapter behind the `KnowledgeReranker` contract - no change to the retrieval
 * pipeline or the service.
 */

import type { ProviderDeps } from '@seo/contracts';
import { NO_KNOWLEDGE_RERANKER, type KnowledgeReranker } from '../knowledge/retrieval/rerank.js';
import { CohereKnowledgeReranker } from './rerank/cohereReranker.js';

export const KNOWLEDGE_RERANKER_PROVIDERS = ['none', 'cohere'] as const;
export type KnowledgeRerankerProvider = (typeof KNOWLEDGE_RERANKER_PROVIDERS)[number];

export function createKnowledgeReranker(deps: ProviderDeps): KnowledgeReranker {
  const raw = deps.config.KNOWLEDGE_RERANKER_PROVIDER;
  const provider = typeof raw === 'string' ? raw.trim().toLowerCase() : 'none';
  switch (provider) {
    case 'cohere':
      return new CohereKnowledgeReranker(deps);
    default:
      return NO_KNOWLEDGE_RERANKER;
  }
}
