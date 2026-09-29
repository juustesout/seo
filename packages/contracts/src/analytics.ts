/**
 * Google Analytics (GA4) contracts (P4).
 *
 * GA4 is a read-only Google data source that answers "which pages actually
 * receive traffic?". The account owns the Google Analytics OAuth connection; a
 * project selects exactly one GA4 property to read page traffic from. No token,
 * Google credential or raw Google API response ever crosses this boundary - the
 * fields here are the normalized application DTOs only.
 */

/** The account's Google Analytics authorization state (no secrets). */
export interface AnalyticsConnectionDto {
  connected: boolean;
  integration_id: string | null;
  status: string | null;
  /** The Google account the authorization belongs to (for "Connected as"). */
  account_email: string | null;
  error: string | null;
}

/** A GA4 property as discovered from Google Analytics metadata. */
export interface AnalyticsPropertyDto {
  /** GA4 numeric property id (normalized, e.g. "properties/123" -> "123"). */
  property_id: string;
  /** Google's real property display name, never invented. */
  property_name: string;
  /** Default web-stream URI when the property exposes one, else null. */
  property_url: string | null;
}

/** A page-traffic row for one page path over the selected period. */
export interface AnalyticsPageTrafficRow {
  /** Canonical page path from GA4 (e.g. "/blog/seo-guide"). */
  path: string;
  /** GA4 screenPageViews: how many times the page was viewed. */
  views: number;
  /** GA4 activeUsers: distinct users who engaged with the page. */
  active_users: number;
  /** GA4 sessions: sessions in which the page was viewed. */
  sessions: number;
}

/** The supported page-traffic periods; the UI offers exactly these. */
export type AnalyticsPeriodDays = 7 | 28 | 90;

/** Normalized page-traffic report. `rows` may be empty (no traffic recorded). */
export interface AnalyticsPageTrafficReportDto {
  property: AnalyticsPropertyDto | null;
  period: { days: AnalyticsPeriodDays; start_date: string; end_date: string };
  rows: AnalyticsPageTrafficRow[];
  /** The row cap applied to the GA4 query. */
  limit: number;
  /** True when Google returned at least `limit` rows (results are truncated). */
  truncated: boolean;
}

/** Per-project Analytics state for Settings (cheap; no live Google call). */
export interface ProjectAnalyticsStateDto {
  google: AnalyticsConnectionDto;
  current: AnalyticsPropertyDto | null;
  /** Whether the caller may change the project's Analytics property. */
  can_manage: boolean;
}

/** Live property discovery result. `properties` may be empty. */
export interface ProjectAnalyticsPropertiesDto {
  google: AnalyticsConnectionDto;
  properties: AnalyticsPropertyDto[];
}

/** Select (or replace) the project's GA4 property. */
export interface AnalyticsPropertySelectRequest {
  property_id: string;
}
