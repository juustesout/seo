/**
 * Google Ads API client (P5).
 *
 * Thin, stateless wrapper over the two read-only REST surfaces the integration
 * needs:
 *   - `customers:listAccessibleCustomers` - the customers the authorized
 *     account can reach directly (CustomerService.ListAccessibleCustomers).
 *   - `customers/{id}/googleAds:searchStream` - Google Ads Query Language
 *     (GAQL) reporting for search terms and keywords.
 *
 * The client owns Google Ads transport and normalization only. It is
 * constructed with one access token and reports a 401 as UnauthorizedError so
 * the caller (service) can refresh once and retry. Raw Google payloads are
 * normalized here and never returned further up; the service exposes
 * application DTOs only.
 *
 * Read-only by construction: this client never calls a mutate method. The
 * single `adwords` OAuth scope is read-write, but the only operations issued
 * are reads (discovery + reporting queries).
 *
 * Developer tokens were sunset on 2026-09-09 (API access levels now attach to
 * the Google Cloud project owning the OAuth client). The client therefore does
 * not require one; if `developerToken` is configured it is forwarded for
 * legacy continuity only.
 */

import { fetchWithTimeout } from '../../http/fetchTimeout.js';

export const GOOGLE_ADS_BASE_HOST = 'https://googleads.googleapis.com';
export const GOOGLE_ADS_DEFAULT_VERSION = 'v25';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** The access token was rejected (expired/revoked) - caller should refresh once. */
export class UnauthorizedError extends Error {
  constructor(message = 'Google Ads authorization expired') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** A real Google Ads API failure (configuration, quota, permission, query, ...). */
export class GoogleAdsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The Google `error.status` reason (PERMISSION_DENIED, INVALID_ARGUMENT, ...). */
    readonly reason: string | null = null,
    /** The most specific provider error code (e.g. CUSTOMER_NOT_FOUND). */
    readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = 'GoogleAdsError';
  }
}

/**
 * Per-request usage reporter (P5). Invoked once for every real Google Ads API
 * request, after the outcome is known. It reports only the operation kind and
 * success; the service binds project/user/usage scope and never observes OAuth
 * or identity lookups.
 */
export type GoogleAdsRequestObserver = (operation: string, success: boolean) => Promise<void>;

/** A Google Ads customer's Google-reported metadata. */
export interface GoogleAdsCustomerMeta {
  customerId: string;
  name: string;
  currencyCode: string | null;
  isManager: boolean;
  status: string | null;
}

/** One normalized search-term row (no raw Google payload). */
export interface GoogleAdsSearchTermRow {
  search_term: string;
  status: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  ctr: number;
}

/** One normalized keyword row (no raw Google payload). */
export interface GoogleAdsKeywordRow {
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

export interface GoogleAdsReportQuery {
  startDate: string;
  endDate: string;
  limit: number;
  filter?: string | null;
  loginCustomerId?: string | null;
}

export interface GoogleAdsClientOptions {
  /** Deprecated, optional. Forwarded as `developer-token` when set. */
  developerToken?: string | null;
  /** REST API version, e.g. `v25`. */
  version?: string;
  fetchFn?: typeof fetch;
  observe?: GoogleAdsRequestObserver;
}

type Row = Record<string, unknown>;

/** GAQL accepts at most these characters in our free-text filter. */
const FILTER_RE = /^[A-Za-z0-9 .-]{1,50}$/;

/**
 * True when `value` is safe to embed in a GAQL `LIKE` string literal. The
 * allowed set excludes every GAQL quoting/wildcard metacharacter
 * (`'`, `\`, `%`, `_`, `[`, `]`) so a filter can never break out of the
 * literal or inject a clause.
 */
export function isValidAdsFilter(value: string): boolean {
  return FILTER_RE.test(value.trim());
}

/** `customers/1234567890` -> `1234567890`; already-numeric ids pass through. */
export function normalizeCustomerId(raw: string): string {
  const trimmed = raw.trim();
  const withoutPath = trimmed.startsWith('customers/') ? trimmed.slice('customers/'.length) : trimmed;
  return withoutPath.replace(/-/g, '');
}

/** Parse a GAQL numeric value (JSON int64s arrive as strings); NaN becomes 0. */
function num(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** `cost_micros` is one-millionths of the customer currency unit. */
function microsToUnits(micros: unknown): number {
  return num(micros) / 1_000_000;
}

function asString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Parse a searchStream response body. Google returns a JSON array of
 * `{ results: [...] }` chunks; some proxies deliver newline-delimited objects
 * instead, so both shapes are tolerated.
 */
export function parseSearchStreamBody(text: string): Row[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const out: Row[] = [];
  const pushChunk = (chunk: unknown) => {
    if (Array.isArray(chunk)) {
      for (const item of chunk) pushChunk(item);
      return;
    }
    if (chunk && typeof chunk === 'object') {
      const results = (chunk as Row).results;
      if (Array.isArray(results)) for (const r of results) out.push(r as Row);
    }
  };
  try {
    pushChunk(JSON.parse(trimmed));
    return out;
  } catch {
    for (const line of trimmed.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        pushChunk(JSON.parse(line));
      } catch {
        // Ignore an unparseable fragment rather than fabricating rows.
      }
    }
    return out;
  }
}

/** Pull the most specific provider error code out of a Google error body. */
function providerCodeOf(body: Row): string | null {
  const details = (body.details as unknown[] | undefined) ?? [];
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    const errors = ((detail as Row).errors as unknown[] | undefined) ?? [];
    for (const e of errors) {
      if (!e || typeof e !== 'object') continue;
      const errorCode = (e as Row).errorCode;
      if (errorCode && typeof errorCode === 'object') {
        for (const value of Object.values(errorCode as Row)) {
          if (typeof value === 'string' && value.length > 0) return value;
        }
      }
    }
  }
  return null;
}

export class GoogleAdsClient {
  private readonly version: string;
  private readonly developerToken: string | null;
  private readonly fetchFn: typeof fetch;
  private readonly observe?: GoogleAdsRequestObserver;

  constructor(
    private readonly accessToken: string,
    options: GoogleAdsClientOptions = {},
  ) {
    this.version = options.version && /^v[0-9]{1,3}$/.test(options.version) ? options.version : GOOGLE_ADS_DEFAULT_VERSION;
    this.developerToken = options.developerToken ?? null;
    this.fetchFn = options.fetchFn ?? fetch;
    this.observe = options.observe;
  }

  private base(): string {
    return `${GOOGLE_ADS_BASE_HOST}/${this.version}`;
  }

  /**
   * Report one actual request outcome, best-effort. A misbehaving observer must
   * never fail the Ads call, so any observer error is swallowed here as well as
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

  private headers(loginCustomerId?: string | null, json = false): Record<string, string> {
    return {
      authorization: `Bearer ${this.accessToken}`,
      accept: 'application/json',
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.developerToken ? { 'developer-token': this.developerToken } : {}),
      ...(loginCustomerId ? { 'login-customer-id': normalizeCustomerId(loginCustomerId) } : {}),
    };
  }

  private async parseError(res: Response): Promise<GoogleAdsError> {
    let reason: string | null = null;
    let providerCode: string | null = null;
    let detail: string;
    try {
      const body = (await res.json()) as Row;
      const error = (body.error as Row | undefined) ?? {};
      detail = typeof error.message === 'string' ? error.message : '';
      reason = typeof error.status === 'string' ? error.status : null;
      providerCode = providerCodeOf(error);
    } catch {
      detail = '';
    }
    return new GoogleAdsError(
      `Google Ads request failed (${res.status})${detail ? `: ${detail}` : ''}`,
      res.status,
      reason,
      providerCode,
    );
  }

  /** One GET against a discovery endpoint. */
  private async get(operation: string, url: string, loginCustomerId?: string | null): Promise<Row> {
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, url, { headers: this.headers(loginCustomerId) });
    } catch (err) {
      await this.record(operation, false);
      throw err;
    }
    if (res.status === 401) {
      await this.record(operation, false);
      throw new UnauthorizedError();
    }
    if (!res.ok) {
      const error = await this.parseError(res);
      await this.record(operation, false);
      throw error;
    }
    await this.record(operation, true);
    return (await res.json()) as Row;
  }

  /** One GAQL query via searchStream, returning every result row. */
  private async search(
    operation: string,
    customerId: string,
    query: string,
    loginCustomerId?: string | null,
  ): Promise<Row[]> {
    const url = `${this.base()}/customers/${normalizeCustomerId(customerId)}/googleAds:searchStream`;
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, url, {
        method: 'POST',
        headers: this.headers(loginCustomerId, true),
        body: JSON.stringify({ query }),
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
      const error = await this.parseError(res);
      await this.record(operation, false);
      throw error;
    }
    const text = await res.text();
    await this.record(operation, true);
    return parseSearchStreamBody(text);
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

  /** Every customer the authorization can reach directly (resource names). */
  async listAccessibleCustomers(): Promise<string[]> {
    const json = await this.get('list_accessible_customers', `${this.base()}/customers:listAccessibleCustomers`);
    const names = (json.resourceNames as unknown[] | undefined) ?? [];
    const ids: string[] = [];
    for (const name of names) {
      if (typeof name !== 'string' || name.length === 0) continue;
      const id = normalizeCustomerId(name);
      if (/^[0-9]{1,20}$/.test(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /** Google-reported metadata for one customer (name, currency, manager flag). */
  async getCustomerMeta(customerId: string, loginCustomerId?: string | null): Promise<GoogleAdsCustomerMeta | null> {
    const rows = await this.search(
      'get_customer',
      customerId,
      'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.status FROM customer',
      loginCustomerId,
    );
    const customer = (rows[0]?.customer as Row | undefined) ?? null;
    if (!customer) return null;
    const id = normalizeCustomerId(String(customer.id ?? customerId));
    const name = asString(customer.descriptiveName);
    return {
      customerId: id,
      name: name ?? `Account ${id}`,
      currencyCode: asString(customer.currencyCode),
      isManager: customer.manager === true,
      status: asString(customer.status),
    };
  }

  /**
   * Customer accounts reachable through a manager (MCC) account, one hierarchy
   * level. Bounded by a query LIMIT so a large hierarchy never fans out.
   */
  async listManagedCustomers(managerId: string): Promise<GoogleAdsCustomerMeta[]> {
    const rows = await this.search(
      'list_managed_customers',
      managerId,
      'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.status = \'ENABLED\' LIMIT 200',
      managerId,
    );
    const out: GoogleAdsCustomerMeta[] = [];
    for (const row of rows) {
      const client = (row.customerClient as Row | undefined) ?? null;
      if (!client) continue;
      const id = normalizeCustomerId(String(client.id ?? ''));
      if (!/^[0-9]{1,20}$/.test(id)) continue;
      out.push({
        customerId: id,
        name: asString(client.descriptiveName) ?? `Account ${id}`,
        currencyCode: asString(client.currencyCode),
        isManager: client.manager === true,
        status: asString(client.status),
      });
    }
    return out;
  }

  /** Paid search terms over [startDate, endDate], highest impressions first. */
  async searchTerms(
    customerId: string,
    options: GoogleAdsReportQuery,
  ): Promise<{ rows: GoogleAdsSearchTermRow[]; truncated: boolean }> {
    const filterClause =
      options.filter && isValidAdsFilter(options.filter)
        ? ` AND search_term_view.search_term LIKE '%${options.filter.trim()}%'`
        : '';
    const query =
      'SELECT search_term_view.search_term, search_term_view.status, ' +
      'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr ' +
      'FROM search_term_view ' +
      `WHERE segments.date BETWEEN '${options.startDate}' AND '${options.endDate}'${filterClause} ` +
      `ORDER BY metrics.impressions DESC LIMIT ${options.limit}`;
    const rows = await this.search('search_terms', customerId, query, options.loginCustomerId);
    const normalized: GoogleAdsSearchTermRow[] = [];
    for (const row of rows) {
      const view = (row.searchTermView as Row | undefined) ?? {};
      const metrics = (row.metrics as Row | undefined) ?? {};
      const term = asString(view.searchTerm);
      if (!term) continue;
      normalized.push({
        search_term: term,
        status: asString(view.status),
        impressions: num(metrics.impressions),
        clicks: num(metrics.clicks),
        cost: microsToUnits(metrics.costMicros),
        conversions: num(metrics.conversions),
        ctr: num(metrics.ctr),
      });
    }
    return { rows: normalized, truncated: normalized.length >= options.limit };
  }

  /** Bid keywords over [startDate, endDate], highest impressions first. */
  async keywords(
    customerId: string,
    options: GoogleAdsReportQuery,
  ): Promise<{ rows: GoogleAdsKeywordRow[]; truncated: boolean }> {
    const filterClause =
      options.filter && isValidAdsFilter(options.filter)
        ? ` AND ad_group_criterion.keyword.text LIKE '%${options.filter.trim()}%'`
        : '';
    const query =
      'SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ' +
      'ad_group_criterion.status, campaign.name, ad_group.name, ' +
      'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr ' +
      'FROM keyword_view ' +
      `WHERE segments.date BETWEEN '${options.startDate}' AND '${options.endDate}'${filterClause} ` +
      `ORDER BY metrics.impressions DESC LIMIT ${options.limit}`;
    const rows = await this.search('keywords', customerId, query, options.loginCustomerId);
    const normalized: GoogleAdsKeywordRow[] = [];
    for (const row of rows) {
      const criterion = (row.adGroupCriterion as Row | undefined) ?? {};
      const keyword = (criterion.keyword as Row | undefined) ?? {};
      const metrics = (row.metrics as Row | undefined) ?? {};
      const text = asString(keyword.text);
      if (!text) continue;
      normalized.push({
        keyword_text: text,
        match_type: asString(keyword.matchType) ?? 'UNKNOWN',
        status: asString(criterion.status),
        campaign_name: asString(((row.campaign as Row | undefined) ?? {}).name),
        ad_group_name: asString(((row.adGroup as Row | undefined) ?? {}).name),
        impressions: num(metrics.impressions),
        clicks: num(metrics.clicks),
        cost: microsToUnits(metrics.costMicros),
        conversions: num(metrics.conversions),
        ctr: num(metrics.ctr),
      });
    }
    return { rows: normalized, truncated: normalized.length >= options.limit };
  }
}
