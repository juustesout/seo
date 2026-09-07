/**
 * Thin Search Console Data API client. Pure transport + JSON handling; all
 * higher-level logic (token refresh, pagination, normalization) lives in the
 * GSC data-source adapter.
 *
 * The client is intentionally dumb and stateless: it holds one access token
 * and knows nothing about credential storage or retry. That keeps the single
 * tricky concern - "when do we refresh a 401?" - owned by exactly one place
 * (GscDataSource.apiWithRefresh) instead of scattered across call sites.
 * Every method either returns the parsed JSON or throws UnauthorizedError /
 * Error; it never fabricates rows.
 */

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Raw shape of a searchAnalytics/query response (rows are optional when empty). */
export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
}

/** A Search Console property the connected account can read. */
export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

const BASE = 'https://searchconsole.googleapis.com/webmasters/v3';

/**
 * Sentinel for auth failures. Distinct from a generic Error so the adapter
 * can distinguish "expired/invalid token - refresh and retry" from every
 * other remote problem without parsing Google error text.
 */
export class UnauthorizedError extends Error {}

/**
 * One access token's worth of Search Console calls. `request` attaches the
 * Bearer token server-side; tokens never appear in error messages.
 */
export class GscApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * Authenticated request shared by every method. 401/403 map to
   * UnauthorizedError (the adapter reacts by refreshing); other failures
   * become a plain Error with a truncated body. JSON parsing happens here so
   * callers receive typed results or a thrown error, never a half-parsed body.
   */
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(`${BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new UnauthorizedError(`Google returned ${res.status}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Search Console API ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** List every Search Console property visible to the access token. */
  async listSites(): Promise<SiteEntry[]> {
    const data = await this.request<{ siteEntry?: SiteEntry[] }>('/sites');
    return data.siteEntry ?? [];
  }

  /**
   * Query search analytics. `siteUrl` must be URL-encoded for the path.
   * Defaults (no dimensions, rowLimit 1000, final data) mirror what the
   * dashboard needs; callers that chunk date ranges pass explicit bounds and
   * a date dimension so rows are comparable day-over-day.
   */
  async searchAnalytics(
    siteUrl: string,
    body: {
      startDate: string;
      endDate: string;
      dimensions?: string[];
      rowLimit?: number;
      dataState?: 'final' | 'all';
      dimensionFilterGroups?: unknown;
    },
  ): Promise<SearchAnalyticsResponse> {
    const path = `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    return this.request<SearchAnalyticsResponse>(path, {
      method: 'POST',
      body: JSON.stringify({
        startDate: body.startDate,
        endDate: body.endDate,
        dimensions: body.dimensions ?? [],
        rowLimit: body.rowLimit ?? 1000,
        dataState: body.dataState ?? 'final',
        dimensionFilterGroups: body.dimensionFilterGroups,
      }),
    });
  }
}
