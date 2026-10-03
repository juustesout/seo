/**
 * Google Ads account + project helpers (P5).
 *
 * The Google Ads connection is owned by the account (like Search Console and
 * Analytics) and authorized once; a project then selects a single Google Ads
 * customer to read paid search intelligence from. The browser never holds a
 * Google token: it asks the API for a consent URL and hands the tab to Google,
 * and all search-intelligence reads go through the API which resolves
 * credentials server-side.
 */
import { api } from './api';

/** The account's Google Ads authorization state (shape mirrors the API DTO). */
export interface AdsConnection {
  connected: boolean;
  integration_id: string | null;
  status: string | null;
  account_email: string | null;
  error: string | null;
}

export interface AdsCustomer {
  customer_id: string;
  name: string;
  currency_code: string | null;
  is_manager: boolean;
  login_customer_id: string | null;
  status: string | null;
}

export interface AdsSearchTermRow {
  search_term: string;
  status: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  ctr: number;
}

export interface AdsKeywordRow {
  keyword_text: string;
  match_type: string;
  status: string | null;
  campaign_name: string | null;
  ad_group_name: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  ctr: number;
}

export interface AdsReport {
  customer: { customer_id: string; name: string; currency_code: string | null } | null;
  period: { days: number; start_date: string; end_date: string };
  search_terms: AdsSearchTermRow[];
  keywords: AdsKeywordRow[];
  limit: number;
  search_terms_truncated: boolean;
  keywords_truncated: boolean;
}

export interface AdsState {
  google: AdsConnection;
  current: AdsCustomer | null;
  can_manage: boolean;
}

/** Start the account-level Google Ads consent flow in this tab. */
export async function connectAds(): Promise<void> {
  const r = await api<{ url: string }>('/account/ads/connect-url');
  window.location.href = r.url;
}

/** Account-level Google Ads connection state. */
export function adsAccountState(): Promise<AdsConnection> {
  return api<AdsConnection>('/account/ads/state');
}

/** Disconnect Google Ads for the account (drops the stored Ads tokens). */
export function disconnectAds(): Promise<{ ok: boolean; was_connected: boolean }> {
  return api('/account/ads/disconnect', { method: 'POST', body: {} });
}

/** Per-project Ads state (cheap; no live Google call). */
export function projectAdsState(projectId: string): Promise<AdsState> {
  return api<AdsState>(`/projects/${projectId}/ads/state`);
}

/** Live discovery of the account's Google Ads customers. */
export function projectAdsCustomers(projectId: string): Promise<{ google: AdsConnection; customers: AdsCustomer[] }> {
  return api(`/projects/${projectId}/ads/customers`);
}

/** Bind (or replace) the project's Google Ads customer. */
export function selectAdsCustomer(projectId: string, customerId: string): Promise<{ customer: AdsCustomer }> {
  return api(`/projects/${projectId}/ads/customer`, { method: 'PUT', body: { customer_id: customerId } });
}

/** Clear the project's Ads binding. */
export function clearAdsCustomer(projectId: string): Promise<{ ok: boolean }> {
  return api(`/projects/${projectId}/ads/customer`, { method: 'DELETE' });
}

/** Normalized paid search intelligence for the project's bound customer. */
export function adsReport(projectId: string, days: number, filter?: string): Promise<AdsReport> {
  const qs = new URLSearchParams({ days: String(days) });
  if (filter && filter.trim()) qs.set('filter', filter.trim());
  return api<AdsReport>(`/projects/${projectId}/ads/report?${qs.toString()}`);
}
