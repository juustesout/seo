/**
 * Google Search Console as a pluggable SeoDataSource.
 *
 * - Advertises capabilities (keywords/pages/performance) for the UI to discover.
 * - Owns OAuth token lifecycle (refresh on 401) using a server-held refresh token.
 * - Normalizes Search Console responses into platform SEO models.
 * - Holds no project/business logic.
 *
 * Row granularity matters here: Search Console caps responses at 25k rows and
 * is slow for wide date ranges, so fetchDimension chunks the requested window
 * into week-sized slices (25k rows each) and paces calls so a full sync never
 * trips Google's per-second quota. Tokens are read from ctx.credentials on
 * every call - never cached in instance state - so one adapter instance can
 * serve many projects/integrations concurrently.
 */

import type {
  KeywordPerformance,
  PagePerformance,
  ProviderContext,
  ProviderDeps,
  SeoDataSource,
} from '@seo/contracts';
import { GscApiClient, UnauthorizedError } from './gscApi.js';
import { refreshAccessToken } from './oauth.js';
import { delay } from '../../util.js';

/**
 * Encrypted-credential keys the integration owns. scope records which Google
 * scopes the token was minted under so a later consent with different scopes
 * does not silently reuse an over-narrow token.
 */
const TOKEN_KEYS = {
  access: 'google_access_token',
  refresh: 'google_refresh_token',
  scope: 'google_token_scope',
} as const;

/** Polite pacing between Search Console calls (Google rate-limits bursty clients). */
const CALL_DELAY_MS = 200;
/** Maximum days covered by one dimensioned query (Google's 25k row cap). */
const WEEK = 7;

/** YYYY-MM-DD (Search Console's native date format). */
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** Date arithmetic in UTC so range chunking never drifts across DST. */
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
/**
 * Split [startDate, endDate] into <= sizeDays contiguous windows. Google only
 * returns up to 25k dimensioned rows per request; smaller windows keep each
 * query under the cap for high-volume properties while preserving the full
 * requested range across the batch.
 */
function chunkRanges(startDate: string, endDate: string, sizeDays: number): Array<{ s: string; e: string }> {
  const out: Array<{ s: string; e: string }> = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = addDays(cursor, sizeDays - 1);
    out.push({ s: fmt(cursor), e: fmt(chunkEnd > end ? end : chunkEnd) });
    cursor = addDays(chunkEnd, 1);
  }
  return out;
}

/** A single date's rollup from the date-dimensioned query. */
export interface GscDailyRow {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
/** A date+query row (dimensions ['date','query']). */
export interface GscQueryRowInput extends GscDailyRow {
  keyword: string;
}
/** A date+page row (dimensions ['date','page']). */
export interface GscPageRowInput extends GscDailyRow {
  page: string;
}

/**
 * GSC adapter. Registered once; per-call state (tokens, property) comes from
 * the ProviderContext each sync constructs, so project isolation is a property
 * of the context, not of this object.
 */
export class GscDataSource implements SeoDataSource {
  readonly id = 'gsc';
  readonly name = 'Google Search Console';
  readonly description = 'Search performance, queries and pages from Google Search Console';
  readonly capabilities = ['keywords', 'pages', 'performance'] as const;

  constructor(private readonly deps: ProviderDeps) {}

  /**
   * The server's confidential OAuth client. Throwing here (rather than at
   * first use) surfaces a misconfigured server early with a clear message.
   */
  private oauth() {
    const clientId = this.deps.config.GOOGLE_CLIENT_ID;
    const clientSecret = this.deps.config.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth client is not configured on the server');
    }
    return { clientId, clientSecret };
  }

  /**
   * Run an authenticated GSC call with a single retry after a token refresh.
   * On UnauthorizedError the stored refresh token is exchanged for a new
   * access token (persisted under the same integration) and the call is
   * retried once - two consecutive 401s then propagate as a real error, which
   * means the refresh token itself is invalid and the user must reconnect.
   */
  private async apiWithRefresh<T>(ctx: ProviderContext, fn: (api: GscApiClient) => Promise<T>): Promise<T> {
    const access = await ctx.credentials.get(TOKEN_KEYS.access);
    const refresh = await ctx.credentials.get(TOKEN_KEYS.refresh);
    if (!access || !refresh) {
      throw new Error('Search Console connection is missing OAuth tokens; reconnect the integration');
    }
    const attempt = (token: string) => fn(new GscApiClient(token));
    try {
      return await attempt(access);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      const { clientId, clientSecret } = this.oauth();
      ctx.logger.info('refreshing expired google access token');
      const tokens = await refreshAccessToken({ clientId, clientSecret, refreshToken: refresh });
      await ctx.credentials.set(TOKEN_KEYS.access, tokens.access_token, { scope: tokens.scope });
      return await attempt(tokens.access_token);
    }
  }

  /**
   * The GSC property this sync/connection operates on, read from the data
   * source config. Each project's GSC data source row carries its own
   * siteUrl, which is what keeps one connected account's properties isolated
   * per project.
   */
  private siteUrl(ctx: ProviderContext): string {
    const siteUrl = ctx.config.siteUrl as string | undefined;
    if (!siteUrl) throw new Error('GSC property siteUrl is missing');
    return siteUrl;
  }

  // -- SeoDataSource interface ---------------------------------------------

  /**
   * Verify the token against Google and list the reachable properties. The
   * returned `external` entries drive the property picker in the UI; extra
   * permissionLevel tells the UI which properties the account can only read.
   */
  async connect(ctx: ProviderContext) {
    const sites = await this.apiWithRefresh(ctx, (api) => api.listSites());
    return {
      ok: true,
      message: `Connected - ${sites.length} Search Console propert${sites.length === 1 ? 'y' : 'ies'} available.`,
      external: sites.map((s) => ({
        id: s.siteUrl,
        label: s.siteUrl,
        extra: { permissionLevel: s.permissionLevel },
      })),
    };
  }

  /**
   * Remove every token this integration owns. Deleting the refresh token is
   * what actually revokes server-side access - without it the stored access
   * token would simply be refreshed forever on the next reconnect attempt.
   */
  async disconnect(ctx: ProviderContext): Promise<void> {
    for (const key of Object.values(TOKEN_KEYS)) {
      await ctx.credentials.delete(key);
    }
  }

  /** Cheap connectivity probe: list properties with the current (or refreshed) token. */
  async testConnection(ctx: ProviderContext): Promise<{ ok: boolean; message?: string }> {
    const sites = await this.apiWithRefresh(ctx, (api) => api.listSites());
    return { ok: true, message: `${sites.length} properties reachable` };
  }

  /** List properties the connected Google account can access (used at setup). */
  async listProperties(ctx: ProviderContext): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
    const sites = await this.apiWithRefresh(ctx, (api) => api.listSites());
    return sites.map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
  }

  // -- GSC-specific detail retrieval (used by the GSC sync executor) --------

  /**
   * One row per day for the whole range (dimension ['date']). Used by the
   * dashboard rollups; rows with a non-date key (Google sometimes pads with
   * "(other)") are dropped so downstream writers never persist garbage.
   */
  async fetchDaily(ctx: ProviderContext, range: { startDate: string; endDate: string }): Promise<GscDailyRow[]> {
    const siteUrl = this.siteUrl(ctx);
    const rows = await this.apiWithRefresh(ctx, (api) =>
      api.searchAnalytics(siteUrl, {
        startDate: range.startDate,
        endDate: range.endDate,
        dimensions: ['date'],
        rowLimit: 400,
      }),
    );
    await delay(CALL_DELAY_MS);
    return (rows.rows ?? [])
      .map((r) => ({
        date: r.keys[0] ?? '',
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      }))
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  }

  /**
   * Date+query or date+page rows, chunked by week and re-aggregated in
   * memory so callers get the full requested range as one array. Queries and
   * pages share a schema aside from the key column, hence the union return;
   * normalize to KeywordPerformance/PagePerformance via toKeywordPerformance /
   * toPagePerformance.
   */
  async fetchDimension(
    ctx: ProviderContext,
    range: { startDate: string; endDate: string },
    dimensions: ['date', 'query'] | ['date', 'page'],
  ): Promise<Array<GscQueryRowInput | GscPageRowInput>> {
    const siteUrl = this.siteUrl(ctx);
    const out: Array<GscQueryRowInput | GscPageRowInput> = [];
    for (const { s, e } of chunkRanges(range.startDate, range.endDate, WEEK)) {
      const rows = await this.apiWithRefresh(ctx, (api) =>
        api.searchAnalytics(siteUrl, { startDate: s, endDate: e, dimensions, rowLimit: 25000 }),
      );
      await delay(CALL_DELAY_MS);
      for (const row of rows.rows ?? []) {
        const date = row.keys[0] ?? '';
        const key = row.keys[1] ?? '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !key) continue;
        const base = { date, clicks: row.clicks ?? 0, impressions: row.impressions ?? 0, ctr: row.ctr ?? 0, position: row.position ?? 0 };
        out.push(dimensions[1] === 'query' ? { ...base, keyword: key } : { ...base, page: key });
      }
    }
    return out;
  }
}

/** Keep only the query-keyed rows and adapt them to the shared KeywordPerformance model. */
export function toKeywordPerformance(rows: Array<GscQueryRowInput | GscPageRowInput>): KeywordPerformance[] {
  return rows
    .filter((r): r is GscQueryRowInput => 'keyword' in r)
    .map((r) => ({ date: r.date, keyword: r.keyword, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
}

/** Keep only the page-keyed rows and adapt them to the shared PagePerformance model. */
export function toPagePerformance(rows: Array<GscQueryRowInput | GscPageRowInput>): PagePerformance[] {
  return rows
    .filter((r): r is GscPageRowInput => 'page' in r)
    .map((r) => ({ date: r.date, page: r.page, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
}
