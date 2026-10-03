/**
 * Google Ads contracts (P5).
 *
 * Google Ads is a read-only Google data source alongside Search Console and
 * Analytics: it answers "which search terms and keywords actually receive paid
 * traffic?". The account owns the Google Ads OAuth connection (an
 * account-scoped seo_integrations row with provider_type = 'ads', project_id
 * NULL); a project selects exactly one authorized Google Ads customer to read
 * search intelligence from. No token, Google credential or raw Google Ads API
 * response ever crosses this boundary - the fields here are normalized
 * application DTOs only.
 *
 * Keyword and search term are deliberately distinct types and lists: an Ads
 * keyword is what the advertiser bid on, a search term is what the user
 * actually typed. Flattening them would destroy the distinction later needed
 * to compare GSC organic queries, Ads search terms and Ads keywords.
 */

/** The account's Google Ads authorization state (no secrets). */
export interface GoogleAdsConnectionDto {
  connected: boolean;
  integration_id: string | null;
  status: string | null;
  /** The Google account the authorization belongs to (for "Connected as"). */
  account_email: string | null;
  error: string | null;
}

/** A Google Ads customer account accessible to the account's authorization. */
export interface GoogleAdsCustomerDto {
  /** Numeric customer id, normalized ("customers/123" -> "123"). */
  customer_id: string;
  /** Google's real descriptive name, never invented. */
  name: string;
  /** ISO 4217 currency of the customer's cost metrics, when Google reports one. */
  currency_code: string | null;
  /** True when this is a manager (MCC) account. */
  is_manager: boolean;
  /**
   * Manager customer id to send as `login-customer-id` when querying this
   * customer. Null for customers reached with the authorizing credentials
   * directly.
   */
  login_customer_id: string | null;
  /** Google's reported customer status (ENABLED, CANCELED, ...). */
  status: string | null;
}

/** The supported search-intelligence periods; the UI offers exactly these. */
export type GoogleAdsPeriodDays = 7 | 28 | 90;

/** One paid search term row. */
export interface GoogleAdsSearchTermRow {
  /** The user's actual search query (search_term_view.search_term). */
  search_term: string;
  /** search_term_view.status (e.g. ADDED, EXCLUDED, NONE). */
  status: string | null;
  impressions: number;
  clicks: number;
  /** cost_micros / 1,000,000, expressed in the customer's currency. */
  cost: number;
  /** Conversions attributed to the term (may be fractional in Google Ads). */
  conversions: number;
  /** Click-through rate as reported by Google (0..1). */
  ctr: number;
}

/** One keyword row (what the advertiser bid on, not what was searched). */
export interface GoogleAdsKeywordRow {
  keyword_text: string;
  /** BROAD / PHRASE / EXACT / UNKNOWN. */
  match_type: string;
  /** ENABLED / PAUSED / REMOVED / ... */
  status: string | null;
  campaign_name: string | null;
  ad_group_name: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  ctr: number;
}

/** Normalized, read-only search intelligence for a project's bound customer. */
export interface GoogleAdsReportDto {
  customer: { customer_id: string; name: string; currency_code: string | null } | null;
  period: { days: GoogleAdsPeriodDays; start_date: string; end_date: string };
  search_terms: GoogleAdsSearchTermRow[];
  keywords: GoogleAdsKeywordRow[];
  /** The row cap applied to each Google Ads query. */
  limit: number;
  /** True when Google returned exactly `limit` rows for that list (truncated). */
  search_terms_truncated: boolean;
  keywords_truncated: boolean;
}

/** Per-project Google Ads state for Settings (cheap; no live Google call). */
export interface ProjectAdsStateDto {
  google: GoogleAdsConnectionDto;
  current: GoogleAdsCustomerDto | null;
  can_manage: boolean;
}

/** Live customer discovery result. `customers` may be empty. */
export interface GoogleAdsCustomersDto {
  google: GoogleAdsConnectionDto;
  customers: GoogleAdsCustomerDto[];
}

/** Select (or replace) the project's bound Google Ads customer. */
export interface GoogleAdsCustomerSelectRequest {
  customer_id: string;
}
