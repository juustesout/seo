/**
 * Google Analytics (GA4) API client.
 *
 * Thin, stateless wrapper over the two Google APIs the read-only integration
 * needs:
 *   - Admin API  (`analyticsadmin.googleapis.com/v1beta`): accountSummaries to
 *     discover the properties the authorized account can read, and dataStreams
 *     to resolve a property's real website URL.
 *   - Data API   (`analyticsdata.googleapis.com/v1beta`): runReport to read
 *     page traffic (screenPageViews / activeUsers / sessions) per page path.
 *
 * The client owns no credentials lifecycle: it is constructed with one access
 * token and reports a 401 as UnauthorizedError so the caller (service) can
 * refresh once and retry. Raw Google payloads are normalized here and never
 * returned further up - the service exposes application DTOs only.
 */

import { fetchWithTimeout } from '../../http/fetchTimeout.js';

export const GA4_ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
export const GA4_DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** How many properties get a dataStreams URL lookup (bounds fan-out per discovery). */
const URL_LOOKUP_LIMIT = 20;
/** Concurrent dataStreams lookups. */
const URL_LOOKUP_CONCURRENCY = 5;

/** The access token was rejected (expired/revoked) - caller should refresh once. */
export class UnauthorizedError extends Error {
  constructor(message = 'Google Analytics authorization expired') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** A real Google Analytics API failure (configuration, quota, permission, ...). */
export class GoogleAnalyticsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GoogleAnalyticsError';
  }
}

/**
 * Per-request usage reporter (P4.5). Invoked once for every real Analytics
 * Admin/Data API request, after the outcome is known. It reports only the
 * operation kind and success; the service binds project/user/usage scope. The
 * userinfo identity lookup is not an Analytics API request and is not observed.
 */
export type Ga4RequestObserver = (operation: string, success: boolean) => Promise<void>;

/** Metadata for one GA4 property. */
export interface AnalyticsPropertyMetadata {
  propertyId: string;
  propertyName: string;
  propertyUrl: string | null;
}

/** One normalized page-traffic row from the Data API. */
export interface PageTrafficRow {
  path: string;
  views: number;
  active_users: number;
  sessions: number;
}

/** `properties/123456` -> `123456`; already-numeric ids pass through. */
export function normalizePropertyId(raw: string): string {
  return raw.startsWith('properties/') ? raw.slice('properties/'.length) : raw;
}

/** Run a mapper over items with a fixed concurrency ceiling, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Parse a GA4 numeric metric value string; non-numeric becomes 0 (never NaN). */
function metricNumber(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export class GoogleAnalyticsClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly observe?: Ga4RequestObserver,
  ) {}

  /**
   * Report one actual request outcome, best-effort. A misbehaving observer must
   * never fail the Analytics call, so any observer error is swallowed here as
   * well as inside the shared append seam.
   */
  private async record(operation: string, success: boolean): Promise<void> {
    if (!this.observe) return;
    try {
      await this.observe(operation, success);
    } catch {
      // Usage is observability, never the request's transaction boundary.
    }
  }

  private async request(operation: string, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          accept: 'application/json',
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      await this.record(operation, false);
      throw err;
    }
    if (res.status === 401) {
      await this.record(operation, false);
      throw new UnauthorizedError();
    }
    if (!res.ok) {
      await this.record(operation, false);
      let detail = '';
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body?.error?.message ?? '';
      } catch {
        detail = '';
      }
      throw new GoogleAnalyticsError(`Google Analytics request failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status);
    }
    await this.record(operation, true);
    return (await res.json()) as Record<string, unknown>;
  }

  /** The Google account email behind the access token (for "Connected as ..."). */
  async getUserEmail(): Promise<string | null> {
    const res = await fetchWithTimeout(this.fetchFn, USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${this.accessToken}`, accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { email?: unknown };
    return typeof json.email === 'string' && json.email.length > 0 ? json.email : null;
  }

  /**
   * The real website URL of a property, taken from its WEB data stream's
   * defaultUri. Best effort: a property with no web stream (or one the token
   * cannot read) yields null so discovery still shows the name/id.
   */
  async getPropertyUrl(propertyId: string): Promise<string | null> {
    try {
      const json = await this.request('list_data_streams', `${GA4_ADMIN_BASE}/properties/${propertyId}/dataStreams?pageSize=100`);
      const streams = (json.dataStreams as Array<Record<string, unknown>> | undefined) ?? [];
      for (const stream of streams) {
        if (stream.type === 'WEB' && typeof stream.webStreamData === 'object' && stream.webStreamData) {
          const uri = (stream.webStreamData as Record<string, unknown>).defaultUri;
          if (typeof uri === 'string' && uri.length > 0) return uri;
        }
      }
      return null;
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      return null;
    }
  }

  /**
   * Every GA4 property the authorized account can read, with real names from
   * accountSummaries. URLs are resolved for a bounded number of properties so a
   * large account does not fan out into hundreds of calls.
   */
  async listProperties(): Promise<AnalyticsPropertyMetadata[]> {
    const json = await this.request('list_properties', `${GA4_ADMIN_BASE}/accountSummaries?pageSize=200`);
    const accounts = (json.accountSummaries as Array<Record<string, unknown>> | undefined) ?? [];
    const properties: AnalyticsPropertyMetadata[] = [];
    for (const account of accounts) {
      const summaries = (account.propertySummaries as Array<Record<string, unknown>> | undefined) ?? [];
      for (const summary of summaries) {
        const ref = summary.property;
        const name = summary.displayName;
        if (typeof ref !== 'string' || typeof name !== 'string') continue;
        properties.push({ propertyId: normalizePropertyId(ref), propertyName: name, propertyUrl: null });
      }
    }
    return mapLimit(properties, URL_LOOKUP_CONCURRENCY, async (property, index) => {
      if (index >= URL_LOOKUP_LIMIT) return property;
      return { ...property, propertyUrl: await this.getPropertyUrl(property.propertyId) };
    });
  }

  /**
   * Page traffic per pagePath for [startDate, endDate] (inclusive, YYYY-MM-DD),
   * highest page views first, capped at `limit` rows. Never returns raw rows.
   */
  async runPageTrafficReport(
    propertyId: string,
    options: { startDate: string; endDate: string; limit: number },
  ): Promise<{ rows: PageTrafficRow[]; truncated: boolean }> {
    const json = await this.request('page_traffic', `${GA4_DATA_BASE}/properties/${propertyId}:runReport`, {
      method: 'POST',
      body: JSON.stringify({
        dateRanges: [{ startDate: options.startDate, endDate: options.endDate }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: options.limit,
      }),
    });
    const rows = (json.rows as Array<Record<string, unknown>> | undefined) ?? [];
    const normalized: PageTrafficRow[] = [];
    for (const row of rows) {
      const dimension = (row.dimensionValues as Array<Record<string, unknown>> | undefined)?.[0]?.value;
      const metrics = (row.metricValues as Array<Record<string, unknown>> | undefined) ?? [];
      if (typeof dimension !== 'string' || dimension.length === 0) continue;
      normalized.push({
        path: dimension,
        views: metricNumber(metrics[0]?.value),
        active_users: metricNumber(metrics[1]?.value),
        sessions: metricNumber(metrics[2]?.value),
      });
    }
    const rowCount = typeof json.rowCount === 'number' ? json.rowCount : normalized.length;
    return { rows: normalized, truncated: rowCount > normalized.length };
  }
}
