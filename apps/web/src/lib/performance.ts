/**
 * Content performance helpers (P7 measurement loop).
 *
 * Mirrors the API DTO for the publication -> search/traffic report. The browser
 * never calls Google: it reads the persisted report and can ask the API to sync
 * the underlying Search Console / Analytics data (which runs as a worker job).
 */
import { api } from './api';

export interface ContentPerformanceSearch {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

export interface ContentPerformanceTraffic {
  views: number;
  active_users: number;
  sessions: number;
}

export type ContentPerformanceState = 'measured' | 'no_traffic';

export interface ContentPerformanceItem {
  content_id: string;
  title: string;
  content_status: string;
  target_keyword: string | null;
  publication_url: string | null;
  published_at: string | null;
  days_live: number | null;
  matched_path: string | null;
  search: ContentPerformanceSearch | null;
  traffic: ContentPerformanceTraffic | null;
  state: ContentPerformanceState;
}

export interface ContentPerformanceReport {
  project_id: string;
  period: { days: number; start_date: string; end_date: string };
  sources: { gsc: boolean; ga4: boolean };
  rows: ContentPerformanceItem[];
  totals: { search: ContentPerformanceSearch | null; traffic: ContentPerformanceTraffic | null };
  last_synced_at: string | null;
  notes: string[];
}

export interface ContentPerformanceSync {
  jobs: Array<{ job_type: string; job_id: string }>;
  reused: boolean;
  skipped: Array<{ provider: 'gsc' | 'ga4'; reason: string }>;
}

/** The persisted measurement report over a period. */
export function contentPerformance(projectId: string, days: number): Promise<ContentPerformanceReport> {
  return api<ContentPerformanceReport>(`/projects/${projectId}/performance?days=${days}`);
}

/** Ask the API to refresh Search Console and/or Analytics data for the loop. */
export function syncContentPerformance(projectId: string, days: number): Promise<ContentPerformanceSync> {
  return api<ContentPerformanceSync>(`/projects/${projectId}/performance/sync`, { method: 'POST', body: { days } });
}
