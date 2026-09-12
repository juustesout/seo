/**
 * KB9 Jina discovery provider: bounded BFS, scope enforcement, de-duplication
 * and honest failure handling. The KnowledgeFetcher is faked, so DNS/network is
 * never touched; the tests assert the exact set of pages the provider chooses
 * to fetch (it must never fetch an out-of-scope page).
 */
import { describe, expect, it, vi } from 'vitest';
import type { FetchedDocument, KnowledgeFetcher } from '@seo/contracts';
import { JinaKnowledgeDiscoveryProvider } from './jinaKnowledgeDiscovery.js';
import { KnowledgeIngestError } from '../../knowledge/errors.js';

function fakeFetcher(pages: Record<string, string>): KnowledgeFetcher & { fetch: ReturnType<typeof vi.fn> } {
  return {
    id: 'jina',
    name: 'Jina Reader',
    isConfigured: () => true,
    fetch: vi.fn(async (url: string): Promise<FetchedDocument> => {
      const contentText = pages[url];
      if (contentText === undefined) throw new KnowledgeIngestError('knowledge_fetch_4xx');
      return { sourceUrl: url, contentText, title: `Title ${url}`, fetchedAt: '2026-01-01T00:00:00.000Z' };
    }),
  } as unknown as KnowledgeFetcher & { fetch: ReturnType<typeof vi.fn> };
}

const SEED = 'https://example.com/';

describe('JinaKnowledgeDiscoveryProvider', () => {
  it('discovers in-scope links, dedupes and bounds to maxUrls', async () => {
    const fetcher = fakeFetcher({
      [SEED]: [
        '[About](https://example.com/about)',
        '[Blog](https://example.com/blog/)',
        '[Blog again](https://example.com/blog)',
        '[External](https://other.com/x)',
        '[Deep](https://blog.example.com/post)',
      ].join('\n'),
    });
    const provider = new JinaKnowledgeDiscoveryProvider({ fetcher });
    const result = await provider.discover(SEED, { maxUrls: 25, maxDepth: 1, scope: 'same_host' });

    const urls = result.links.map((l) => l.url);
    expect(urls).toContain('https://example.com/about');
    // Trailing-slash variants collapse to one candidate.
    expect(urls.filter((u) => u.startsWith('https://example.com/blog'))).toHaveLength(1);
    // same_host excludes the sibling subdomain and other.com.
    expect(urls).not.toContain('https://blog.example.com/post');
    expect(urls.some((u) => u.includes('other.com'))).toBe(false);
    expect(result.seedTitle).toBe(`Title ${SEED}`);
  });

  it('enforces maxUrls', async () => {
    const links = Array.from({ length: 10 }, (_, i) => `[p${i}](https://example.com/p${i})`).join('\n');
    const fetcher = fakeFetcher({ [SEED]: links });
    const provider = new JinaKnowledgeDiscoveryProvider({ fetcher });
    const result = await provider.discover(SEED, { maxUrls: 3, maxDepth: 2, scope: 'same_host' });
    expect(result.links).toHaveLength(3);
  });

  it('depth 0 proposes nothing but still fetches the seed', async () => {
    const fetcher = fakeFetcher({ [SEED]: '[About](https://example.com/about)' });
    const provider = new JinaKnowledgeDiscoveryProvider({ fetcher });
    const result = await provider.discover(SEED, { maxUrls: 25, maxDepth: 0, scope: 'same_host' });
    expect(result.links).toEqual([]);
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it('same_domain follows subdomains but never fetches an out-of-scope page', async () => {
    const fetcher = fakeFetcher({
      [SEED]: '[Blog](https://blog.example.com/post) [Offsite](https://evil.com/x)',
      'https://blog.example.com/post': '[More](https://example.com/more)',
    });
    const provider = new JinaKnowledgeDiscoveryProvider({ fetcher });
    const result = await provider.discover(SEED, { maxUrls: 25, maxDepth: 2, scope: 'same_domain' });
    expect(result.links.map((l) => l.url)).toEqual(
      expect.arrayContaining(['https://blog.example.com/post', 'https://example.com/more']),
    );
    const fetched = fetcher.fetch.mock.calls.map((c) => c[0]);
    expect(fetched).not.toContain('https://evil.com/x');
  });

  it('fails when the seed page cannot be fetched', async () => {
    const fetcher = fakeFetcher({});
    const provider = new JinaKnowledgeDiscoveryProvider({ fetcher });
    await expect(provider.discover(SEED, { maxUrls: 25, maxDepth: 1, scope: 'same_host' })).rejects.toBeInstanceOf(
      KnowledgeIngestError,
    );
  });

  it('skips an unreachable discovered page without failing the proposal', async () => {
    const fetcher = fakeFetcher({
      [SEED]: '[Broken](https://example.com/broken)',
      // https://example.com/broken is intentionally absent -> fetch throws.
    });
    const provider = new JinaKnowledgeDiscoveryProvider({ fetcher });
    const result = await provider.discover(SEED, { maxUrls: 25, maxDepth: 2, scope: 'same_host' });
    expect(result.links.map((l) => l.url)).toEqual(['https://example.com/broken']);
  });
});
