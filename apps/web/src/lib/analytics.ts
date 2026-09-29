/**
 * Google Analytics (GA4) account + project helpers.
 *
 * The GA4 connection is owned by the account (like GSC) and authorized once;
 * a project then selects a single GA4 property to read page traffic from. The
 * browser never holds a Google token: it asks the API for a consent URL and
 * hands the tab to Google, and all page-traffic reads go through the API which
 * resolves credentials server-side.
 */
import { api } from './api';

/** The account's GA4 authorization state (shape mirrors the API DTO). */
export interface AnalyticsConnection {
  connected: boolean;
  integration_id: string | null;
  status: string | null;
  account_email: string | null;
  error: string | null;
}

export interface AnalyticsProperty {
  property_id: string;
  property_name: string;
  property_url: string | null;
}

export interface AnalyticsPageTrafficRow {
  path: string;
  views: number;
  active_users: number;
  sessions: number;
}

export interface AnalyticsPageTrafficReport {
  property: AnalyticsProperty | null;
  period: { days: number; start_date: string; end_date: string };
  rows: AnalyticsPageTrafficRow[];
  limit: number;
  truncated: boolean;
}

export interface AnalyticsState {
  google: AnalyticsConnection;
  current: AnalyticsProperty | null;
  can_manage: boolean;
}

/** Start the account-level Google Analytics consent flow in this tab. */
export async function connectAnalytics(): Promise<void> {
  const r = await api<{ url: string }>('/account/analytics/connect-url');
  window.location.href = r.url;
}

/** Account-level GA4 connection state. */
export function analyticsAccountState(): Promise<AnalyticsConnection> {
  return api<AnalyticsConnection>('/account/analytics/state');
}

/** Disconnect Google Analytics for the account (drops the stored GA4 tokens). */
export function disconnectAnalytics(): Promise<{ ok: boolean; was_connected: boolean }> {
  return api('/account/analytics/disconnect', { method: 'POST', body: {} });
}

/** Per-project Analytics state (cheap; no live Google call). */
export function projectAnalyticsState(projectId: string): Promise<AnalyticsState> {
  return api<AnalyticsState>(`/projects/${projectId}/analytics/state`);
}

/** Live discovery of the account's GA4 properties. */
export function projectAnalyticsProperties(projectId: string): Promise<{ google: AnalyticsConnection; properties: AnalyticsProperty[] }> {
  return api(`/projects/${projectId}/analytics/properties`);
}

/** Bind (or replace) the project's GA4 property. */
export function selectAnalyticsProperty(projectId: string, propertyId: string): Promise<{ property: AnalyticsProperty }> {
  return api(`/projects/${projectId}/analytics/property`, { method: 'PUT', body: { property_id: propertyId } });
}

/** Clear the project's GA4 binding. */
export function clearAnalyticsProperty(projectId: string): Promise<{ ok: boolean }> {
  return api(`/projects/${projectId}/analytics/property`, { method: 'DELETE' });
}

/** Normalized page traffic for the project's bound property over a period. */
export function pageTraffic(projectId: string, days: number): Promise<AnalyticsPageTrafficReport> {
  return api<AnalyticsPageTrafficReport>(`/projects/${projectId}/analytics/page-traffic?days=${days}`);
}
