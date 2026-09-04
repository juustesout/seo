/**
 * Thin Search Console Data API client. Pure transport + JSON handling; all
 * higher-level logic (token refresh, pagination, normalization) lives in the
 * GSC data-source adapter.
 */

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
}

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

const BASE = 'https://searchconsole.googleapis.com/webmasters/v3';

export class UnauthorizedError extends Error {}

export class GscApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

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

  async listSites(): Promise<SiteEntry[]> {
    const data = await this.request<{ siteEntry?: SiteEntry[] }>('/sites');
    return data.siteEntry ?? [];
  }

  /** Query search analytics. `siteUrl` must be URL-encoded for the path. */
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
