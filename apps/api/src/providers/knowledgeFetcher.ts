/**
 * KnowledgeFetcher factory (KB3).
 *
 * The single seam that decides which fetch/extraction provider backs URL
 * ingestion. Today that is Jina; adding or replacing a provider means changing
 * this factory (or resolving by id later), with no change to KnowledgeService,
 * which only ever depends on the `KnowledgeFetcher` contract.
 */

import type { KnowledgeFetcher, ProviderLogger } from '@seo/contracts';
import { JinaKnowledgeFetcher } from './jina/jinaKnowledgeFetcher.js';

export interface KnowledgeFetcherBuildDeps {
  config: Record<string, string | undefined>;
  logger?: ProviderLogger;
  fetchFn?: typeof fetch;
}

export function createKnowledgeFetcher(deps: KnowledgeFetcherBuildDeps): KnowledgeFetcher {
  return new JinaKnowledgeFetcher(deps);
}
