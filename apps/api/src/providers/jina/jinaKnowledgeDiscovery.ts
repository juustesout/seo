/**
 * Jina Reader-backed KnowledgeDiscoveryProvider (KB9).
 *
 * A bounded, breadth-first link discovery over markdown returned by the existing
 * KnowledgeFetcher (Jina). It is explicitly NOT a crawler: it never renders
 * JavaScript, never fetches a page it has already seen, never leaves the seed's
 * scope, and stops at `maxDepth` / `maxUrls` / a hard page cap. The seed page is
 * always fetched (so its failure fails the discovery honestly); a failing child
 * page is skipped, because one broken link must not sink a proposal.
 *
 * The adapter is side-effect free: no database, no Qdrant, no HTTP routes, no
 * credentials beyond the injected fetcher, and no vendor payload ever leaves it
 * - callers only ever see the provider-agnostic `DiscoveredLink[]`.
 */

import type {
  DiscoveredLink,
  KnowledgeDiscoveryOptions,
  KnowledgeDiscoveryProvider,
  KnowledgeDiscoveryResult,
  KnowledgeFetcher,
  ProviderLogger,
} from '@seo/contracts';
import { extractMarkdownLinks, isWithinScope, normalizeDiscoveryUrl } from '../../knowledge/discovery.js';
import { validateExternalUrl } from '../../knowledge/url.js';
import { KNOWLEDGE_DISCOVERY_MAX_DEPTH, KNOWLEDGE_DISCOVERY_MAX_URLS } from '@seo/contracts';

/** Hard cap on pages fetched in one discovery, independent of depth. */
export const MAX_DISCOVERY_PAGES = 25;

export interface JinaDiscoveryDeps {
  fetcher: KnowledgeFetcher;
  logger?: ProviderLogger;
}

function clampUrls(value: number): number {
  if (!Number.isFinite(value)) return KNOWLEDGE_DISCOVERY_MAX_URLS;
  return Math.max(1, Math.min(KNOWLEDGE_DISCOVERY_MAX_URLS, Math.floor(value)));
}

function clampDepth(value: number): number {
  if (!Number.isFinite(value)) return KNOWLEDGE_DISCOVERY_MAX_DEPTH;
  return Math.max(0, Math.min(KNOWLEDGE_DISCOVERY_MAX_DEPTH, Math.floor(value)));
}

interface QueueItem {
  /** Validated, normalized URL to fetch. */
  url: string;
  depth: number;
  discoveredFrom?: string;
}

export class JinaKnowledgeDiscoveryProvider implements KnowledgeDiscoveryProvider {
  readonly id = 'jina';
  readonly name = 'Jina Reader';

  private readonly fetcher: KnowledgeFetcher;
  private readonly logger?: ProviderLogger;

  constructor(deps: JinaDiscoveryDeps) {
    this.fetcher = deps.fetcher;
    this.logger = deps.logger;
  }

  isConfigured(): boolean {
    return this.fetcher.isConfigured();
  }

  async discover(seedUrl: string, options: KnowledgeDiscoveryOptions): Promise<KnowledgeDiscoveryResult> {
    const maxUrls = clampUrls(options.maxUrls);
    const maxDepth = clampDepth(options.maxDepth);
    const maxPages = Math.min(maxUrls, MAX_DISCOVERY_PAGES);
    const seed = validateExternalUrl(seedUrl);
    const seedHost = seed.hostname;
    const normalizedSeed = normalizeDiscoveryUrl(seed.toString());

    const links: DiscoveredLink[] = [];
    const seen = new Set<string>([normalizedSeed]);
    const visited = new Set<string>();
    const queue: QueueItem[] = [{ url: normalizedSeed, depth: 0 }];
    let seedTitle: string | undefined;
    let fetched = 0;

    while (queue.length > 0 && links.length < maxUrls && fetched < maxPages) {
      const current = queue.shift()!;
      if (visited.has(current.url)) continue;
      visited.add(current.url);

      let contentText: string;
      let title: string | undefined;
      try {
        const doc = await this.fetcher.fetch(current.url, { signal: options.signal });
        contentText = doc.contentText;
        title = doc.title;
      } catch (err) {
        if (current.depth === 0) throw err;
        this.logger?.debug('knowledge discovery skipped an unreachable page', {
          url: current.url,
          code: (err as { code?: string })?.code,
        });
        continue;
      }
      fetched += 1;
      if (current.depth === 0) seedTitle = title;
      if (current.depth >= maxDepth) continue;

      for (const extracted of extractMarkdownLinks(contentText)) {
        if (links.length >= maxUrls) break;
        let normalized: string;
        try {
          normalized = normalizeDiscoveryUrl(extracted.url);
        } catch {
          continue;
        }
        if (seen.has(normalized)) continue;
        const host = new URL(normalized).hostname;
        if (!isWithinScope(seedHost, host, options.scope)) continue;
        seen.add(normalized);
        links.push({
          url: extracted.url,
          title: extracted.title,
          depth: current.depth + 1,
          discoveredFrom: current.url,
        });
        if (current.depth + 1 < maxDepth) {
          queue.push({ url: normalized, depth: current.depth + 1, discoveredFrom: current.url });
        }
      }
    }

    return { links, seedTitle };
  }
}
