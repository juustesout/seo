/**
 * KnowledgeDiscoveryProvider factory (KB9).
 *
 * The single seam that decides which discovery provider backs "discover from
 * website". Today that is the bounded Jina discovery adapter, reusing the same
 * configured KnowledgeFetcher as URL ingestion so there is no second fetch
 * implementation. When no fetcher is configured the factory returns null and
 * the service reports discovery as "not configured" - never a fake empty
 * proposal.
 */

import type { KnowledgeDiscoveryProvider, KnowledgeFetcher, ProviderLogger } from '@seo/contracts';
import { JinaKnowledgeDiscoveryProvider } from './jina/jinaKnowledgeDiscovery.js';

export interface KnowledgeDiscoveryProviderBuildDeps {
  fetcher: KnowledgeFetcher | null;
  logger?: ProviderLogger;
}

export function createKnowledgeDiscoveryProvider(
  deps: KnowledgeDiscoveryProviderBuildDeps,
): KnowledgeDiscoveryProvider | null {
  if (!deps.fetcher) return null;
  return new JinaKnowledgeDiscoveryProvider({ fetcher: deps.fetcher, logger: deps.logger });
}
