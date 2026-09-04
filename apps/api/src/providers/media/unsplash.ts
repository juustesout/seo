/**
 * Unsplash stock-image search media provider (MediaProvider.search).
 *
 * Requires UNSPLASH_ACCESS_KEY (server-side env). Results point to Unsplash
 * URLs and are meant to be hotlinked with attribution in the article metadata.
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

export class UnsplashMediaProvider implements MediaProvider {
  readonly id = 'unsplash';
  readonly name = 'Unsplash';
  readonly description = 'Search high-quality stock photos (Unsplash API)';
  readonly capabilities: readonly MediaCapability[] = ['search'];

  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: UnsplashProviderDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.deps.config.UNSPLASH_ACCESS_KEY);
  }

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
