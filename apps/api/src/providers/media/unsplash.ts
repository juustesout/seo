/**
 * Unsplash stock-image search media provider (MediaProvider.search).
 *
 * Requires UNSPLASH_ACCESS_KEY (server-side env). Results point to Unsplash
 * URLs and are meant to be hotlinked with attribution in the article metadata.
 *
 * The provider deliberately returns remote Unsplash URLs instead of proxying
 * or re-uploading bytes: Unsplash's license terms allow hotlinking with
 * attribution, and storing derived copies would create a second source of
 * truth for the same asset. If the key is absent the provider reports "not
 * configured" (isConfigured false / search throws) - no placeholder image is
 * ever fabricated.
 */

import type {
  MediaResult,
  MediaSearchOptions,
  MediaProvider,
  MediaCapability,
  ProviderLogger,
} from '@seo/contracts';

export interface UnsplashProviderDeps {
  config: Record<string, string | undefined>;
  logger: ProviderLogger;
  fetchFn?: typeof fetch;
}

/**
 * Search-only Unsplash adapter. Stateless apart from config + injected fetch,
 * so a single registry instance safely serves concurrent content-image jobs.
 */
export class UnsplashMediaProvider implements MediaProvider {
  readonly id = 'unsplash';
  readonly name = 'Unsplash';
  readonly description = 'Search high-quality stock photos (Unsplash API)';
  readonly capabilities: readonly MediaCapability[] = ['search'];

  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: UnsplashProviderDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  /** True only when a server key exists; the UI mirrors this for the "not configured" state. */
  isConfigured(): boolean {
    return Boolean(this.deps.config.UNSPLASH_ACCESS_KEY);
  }

  /**
   * Search photos. The API is called with the Client-ID header (not Bearer) -
   * the only auth shape Unsplash accepts. Each result maps to MediaResult with
   * the regular-size image as the primary url and the small crop as thumbnail;
   * descriptions fall back from `description` to `alt_description` so a search
   * card always has alt text.
   */
  async search(opts: MediaSearchOptions): Promise<MediaResult[]> {
    const key = this.deps.config.UNSPLASH_ACCESS_KEY;
    if (!key) {
      throw new Error('Unsplash is not configured: set UNSPLASH_ACCESS_KEY');
    }
    const params = new URLSearchParams({
      query: opts.query,
      per_page: String(opts.limit ?? 8),
    });
    if (opts.orientation) params.set('orientation', opts.orientation);
    const res = await this.fetchFn(`https://api.unsplash.com/search/photos?${params.toString()}`, {
      headers: { authorization: `Client-ID ${key}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Unsplash API ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      results?: Array<{
        id: string;
        urls?: { raw?: string; regular?: string; small?: string };
        width?: number;
        height?: number;
        description?: string | null;
        alt_description?: string | null;
      }>;
    };
    return (json.results ?? []).map((r) => ({
      id: r.id,
      url: r.urls?.regular ?? r.urls?.raw ?? '',
      thumbUrl: r.urls?.small ?? r.urls?.regular,
      width: r.width,
      height: r.height,
      description: r.description ?? r.alt_description ?? undefined,
      source: 'unsplash',
    }));
  }
}
