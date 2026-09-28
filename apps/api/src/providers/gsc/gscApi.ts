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
 * Per-request usage reporter (R5.10.5). Invoked once for every actual GSC API
 * request, after the outcome is known. It is deliberately decoupled from scope:
 * the adapter binds project/user/usage and this client only reports the
 * operation kind and whether the request succeeded.
 */
export type GscRequestObserver = (operation: string, success: boolean) => Promise<void>;

/**
 * One access token's worth of Search Console calls. `request` attaches the
 * Bearer token server-side; tokens never appear in error messages.
 */
export class GscApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly observe?: GscRequestObserver,
  ) {}

  /**
   * Report one actual request outcome, best-effort. A misbehaving observer must
   * never fail the GSC call, so any observer error is swallowed here as well as
   * inside the shared append seam.
   */
  private async record(operation: string, success: boolean): Promise<void> {
    if (!this.observe) return;
    try {
      await this.observe(operation, success);
    } catch {
      // Usage is observability, never the request's transaction boundary.
    }
  }

  /**
   * Authenticated request shared by every method. 401/403 map to
   * UnauthorizedError (the adapter reacts by refreshing); other failures
   * become a plain Error with a truncated body. JSON parsing happens here so
   * callers receive typed results or a thrown error, never a half-parsed body.
   *
   * Every real HTTP request is reported exactly once (success = the HTTP
   * exchange succeeded), including a request that then triggers a token-refresh
   * retry. Local failures before `fetch` report nothing.
   */
  private async request<T>(operation: string, path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${BASE}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          accept: 'application/json',
          'content-type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      await this.record(operation, false);
      throw err;
    }
    if (res.status === 401 || res.status === 403) {
      await this.record(operation, false);
      throw new UnauthorizedError(`Google returned ${res.status}`);
    }
    if (!res.ok) {
      await this.record(operation, false);
      const text = await res.text().catch(() => '');
      throw new Error(`Search Console API ${res.status}: ${text.slice(0, 300)}`);
    }
    await this.record(operation, true);
    return (await res.json()) as T;
  }

  /** List every Search Console property visible to the access token. */
  async listSites(): Promise<SiteEntry[]> {
    const data = await this.request<{ siteEntry?: SiteEntry[] }>('list_sites', '/sites');
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
    return this.request<SearchAnalyticsResponse>('search_analytics', path, {
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
