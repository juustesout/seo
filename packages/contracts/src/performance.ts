/**
 * Content performance contracts (P7 measurement loop).
 *
 * The measurement loop joins the three things the platform already knows -
 * which content was published (and to which URL), how it ranks in Google
 * Search Console, and how much page traffic Google Analytics 4 recorded - into
 * one project-scoped report. It is deliberately not automated SEO: it reports
 * what actually happened after publishing, honestly labelling anything that is
 * not configured or has no data.
 *
 * No Google credential, token or raw Google API payload crosses this boundary;
 * these are the normalized application DTOs only.
 */

/** The supported performance periods; the UI offers exactly these. */
export type PerformancePeriodDays = 7 | 28 | 90;

/** Aggregate Search Console performance for one published content item. */
export interface ContentPerformanceSearch {
  clicks: number;
  impressions: number;
  /** Click-through rate (0..1); 0 when there were no impressions. */
  ctr: number;
  /** Impression-weighted average position, or null when there are no impressions. */
  position: number | null;
}

/** Aggregate GA4 page traffic for one published content item. */
export interface ContentPerformanceTraffic {
  views: number;
  active_users: number;
  sessions: number;
}

/**
 * One content item in the measurement loop. `state` is honest: `measured` means
 * at least one provider row matched the item's URL/path, `no_traffic` means the
 * item is published but no row matched for the period (never a fabricated zero
 * presented as evidence).
 */
export type ContentPerformanceState = 'measured' | 'no_traffic';

export interface ContentPerformanceItem {
  content_id: string;
  title: string;
  /** The content's own status (draft/published/...), never invented. */
  content_status: string;
  target_keyword: string | null;
  /** The live URL captured by the publisher after it confirmed a remote id. */
  publication_url: string | null;
  /** When that successful publication happened, or null when unpublished. */
  published_at: string | null;
  /** Whole days between publication and the report end, or null when unpublished. */
  days_live: number | null;
  /** The normalized path the metrics were matched on, or null when unmatched. */
  matched_path: string | null;
  search: ContentPerformanceSearch | null;
  traffic: ContentPerformanceTraffic | null;
  state: ContentPerformanceState;
}

/** Per-source availability + totals for the report header. */
export interface ContentPerformanceReportDto {
  project_id: string;
  period: { days: PerformancePeriodDays; start_date: string; end_date: string };
  /** Which providers currently have data configured for this project. */
  sources: { gsc: boolean; ga4: boolean };
  rows: ContentPerformanceItem[];
  totals: {
    search: ContentPerformanceSearch | null;
    traffic: ContentPerformanceTraffic | null;
  };
  /** When the traffic/search rows were last synced, or null before the first sync. */
  last_synced_at: string | null;
  /** Human-readable, non-error hints (e.g. "Connect Google Analytics to measure page traffic"). */
  notes: string[];
}

/** Result of asking the platform to refresh the measurement data. */
export interface ContentPerformanceSyncDto {
  /** Job ids enqueued for this refresh (GSC and/or GA4), newest first. */
  jobs: Array<{ job_type: string; job_id: string }>;
  /** True when a matching sync was already queued/running and was reused. */
  reused: boolean;
  /** Providers that could not be synced and why (e.g. "Search Console is not connected"). */
  skipped: Array<{ provider: 'gsc' | 'ga4'; reason: string }>;
}
