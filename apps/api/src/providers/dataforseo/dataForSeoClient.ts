/**
 * DataForSEO API wrapper.
 *
 * Responsibilities (isolated here so nothing else ever talks to DataForSEO):
 *  - authentication (HTTP Basic over login + password)
 *  - request construction
 *  - API error classification (retryable vs permanent)
 *  - retries with exponential backoff + jitter for transient failures
 *  - rate limiting (client-side token bucket, respectful pacing)
 *  - SERP task creation, readiness polling and result retrieval
 *  - live endpoints for SERP + keyword research
 *
 * Everything above the wrapper consumes normalized SEO models (see
 * normalize.ts / dataSource.ts), never raw DataForSEO payloads.
 *
 * Error shape is the wrapper's contract: every failure is a DataForSeoError
 * carrying a `retryable` flag (and the vendor status/code when known). Callers
 * decide retry policy from that flag instead of re-classifying HTTP statuses,
 * which keeps the quota/balance (permanent) vs 5xx/429 (retryable) split in
 * one place.
 */

import { delay } from '../../util.js';

const BASE = 'https://api.dataforseo.com';

/**
 * Typed failure with an explicit retryability decision. `status` is the HTTP
 * status (undefined for network-level failures); `code` is DataForSEO's
 * application status_code when the HTTP layer looked fine but the vendor
 * rejected the request.
 */
export class DataForSeoError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly code?: number,
  ) {
    super(message);
    this.name = 'DataForSeoError';
  }
}

/** Permanent 401/403 credential failure - retrying can never succeed. */
export class AuthError extends DataForSeoError {
  constructor(message: string) {
    super(message, false, 401);
    this.name = 'AuthError';
  }
}

/** A raw organic-SERP result item exactly as the vendor returns it (indexed for tolerating unknown feature types). */
export interface SerpItemRaw {
  type?: string;
  rank_group?: number;
  rank_absolute?: number;
  domain?: string;
  title?: string;
  url?: string;
  breadcrumb?: string;
  description?: string;
  is_paid?: boolean;
  [key: string]: unknown;
}

/** One task's result block (a task may carry several; we read the first). */
export interface SerpTaskResult {
  keyword?: string;
  location_code?: number;
  language_code?: string;
  device?: string;
  se_domain?: string;
  items?: SerpItemRaw[];
  check_url?: string;
  datetime?: string;
  [key: string]: unknown;
}

/** A SERP task as returned by task_post / tasks_ready / task_get. */
export interface SerpTask {
  id: string;
  keyword?: string;
  location_code?: number;
  language_code?: string;
  status_code?: number;
  status_message?: string;
  result?: SerpTaskResult[];
}

/** A keyword suggestion item from keyword_suggestions/live (tolerates both flat and nested shapes). */
export interface KeywordSuggestion {
  /** keyword_suggestions/live returns a flat item; legacy shapes nest under keyword_data. */
  keyword?: string;
  keyword_data?: {
    keyword?: string;
    keyword_info?: KeywordInfo;
    keyword_properties?: {
      keyword_difficulty?: number;
      search_intent?: string;
      cpc?: number;
    };
    serp_info?: unknown;
  };
  keyword_info?: KeywordInfo;
  keyword_properties?: {
    keyword_difficulty?: number;
    keyword_difficulty_info?: { level?: string };
  };
  search_intent_info?: { main_intent?: string };
  [key: string]: unknown;
}

/** Keyword volume/competition metrics, nested under different parents across endpoints. */
interface KeywordInfo {
  search_volume?: number;
  cpc?: number;
  competition?: number;
  monthly_searches?: Array<{ year: number; month: number; search_volume: number }>;
}

/** Keyword difficulty item (keyword_difficulty/live). */
export interface KeywordDifficultyItem {
  keyword_data?: { keyword?: string };
  keyword_properties?: { keyword_difficulty?: number; keyword_difficulty_info?: { level?: string } };
}

/** HTTP statuses where a retry (after backoff) has a real chance of succeeding. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * One DataForSEO account's worth of HTTP. Shared across every data-source call
 * for a given credential, so the token bucket (`pace`) serializes calls from
 * concurrent job/request paths - DataForSEO rejects accounts that burst past
 * their per-minute allowance with 429s.
 */
export class DataForSeoClient {
  private authHeader: string;
  /** Simple token-bucket pacing: at most `ratePerMinute` calls per minute. */
  private nextSlotAt = 0;
  private readonly minIntervalMs: number;

  constructor(
    private readonly creds: { login?: string; password?: string; basicToken?: string },
    private readonly opts: { ratePerMinute?: number; fetchFn?: typeof fetch } = {},
  ) {
    if (creds.basicToken) {
      this.authHeader = `Basic ${creds.basicToken.replace(/^Basic\s+/i, '')}`;
    } else {
      this.authHeader = `Basic ${Buffer.from(`${creds.login ?? ''}:${creds.password ?? ''}`).toString('base64')}`;
    }
    const rpm = opts.ratePerMinute ?? 40;
    this.minIntervalMs = rpm > 0 ? Math.ceil(60000 / rpm) : 0;
  }

  /**
   * Wait until the next rate-limit slot, then reserve it. Reservations are
   * spaced minIntervalMs apart; the interval is derived from ratePerMinute so
   * the same client honors whatever allowance the caller configured.
   */
  private async pace() {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    if (this.nextSlotAt > now) {
      await delay(this.nextSlotAt - now);
    }
    this.nextSlotAt = Math.max(this.nextSlotAt, Date.now()) + this.minIntervalMs;
  }

  /**
   * Turn a vendor failure into a retryable/permanent decision. 401/403 are
   * auth problems (permanent), known quota/balance codes are permanent (they
   * will not clear in a retry window), and everything else follows the HTTP
   * status map. Keeping this classification here means callers never re-parse
   * vendor error text.
   */
  private classify(message: string, status: number | undefined, code: number | undefined): DataForSeoError {
    if (status === 401 || status === 403) return new AuthError(`DataForSEO authentication failed (${status})`);
    if (code === 9001 || code === 9002 || code === 9003 || code === 90203 || code === 90206) {
      return new DataForSeoError(`DataForSEO quota/balance error: ${message}`, false, status, code);
    }
    const retryable = status !== undefined ? RETRYABLE_STATUS.has(status) : false;
    return new DataForSeoError(message, retryable, status, code);
  }

  /**
   * The one HTTP path every call goes through. Retries network failures and
   * retryable vendor errors up to maxAttempts with exponential backoff (+
   * jitter so a fleet of retrying jobs does not pile onto the vendor at the
   * same instant); permanent errors and quota failures throw immediately.
   * DataForSEO signals success via a status_code in the 20000-29999 window,
   * so an HTTP-200 body still goes through that check before being returned.
   */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const maxAttempts = 4;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.pace();
      let res: Response;
      try {
        res = await fetchFn(`${BASE}${path}`, {
          method,
          headers: {
            authorization: this.authHeader,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'network error';
        if (attempt < maxAttempts) {
          await delay(1000 * 2 ** (attempt - 1));
          continue;
        }
        throw new DataForSeoError(`DataForSEO network failure: ${msg}`, true);
      }

      let json: Record<string, unknown>;
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        const text = await res.text().catch(() => '');
        if (!res.ok) throw this.classify(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, undefined);
        throw new DataForSeoError(`Unexpected DataForSEO response: ${text.slice(0, 200)}`, false, res.status);
      }

      const status = res.status;
      const statusCode = typeof json.status_code === 'number' ? json.status_code : undefined;
      const statusMessage =
        typeof json.status_message === 'string' ? json.status_message : `HTTP ${status}`;

      if (res.ok && statusCode !== undefined && statusCode >= 20000 && statusCode < 30000) {
        return json as T;
      }
      if (res.ok && statusCode !== undefined && statusCode < 0) {
        return json as T;
      }

      const error = this.classify(statusMessage, status, statusCode);
      if (error.retryable && attempt < maxAttempts) {
        await delay(1000 * 2 ** (attempt - 1) + Math.random() * 500);
        continue;
      }
      throw error;
    }
  }

  // -- SERP (task based) ----------------------------------------------------

  /** Create organic SERP tasks for a batch of keywords. Max 100/batch. */
  async postSerpOrganicTasks(items: Array<Record<string, unknown>>): Promise<SerpTask[]> {
    const data = await this.request<{ tasks?: SerpTask[] }>('POST', '/v3/serp/google/organic/task_post', items);
    return data.tasks ?? [];
  }

  /** List task ids that are ready to be fetched. */
  async serpTasksReady(): Promise<SerpTask[]> {
    const data = await this.request<{ tasks?: SerpTask[] }>('GET', '/v3/serp/google/organic/tasks_ready');
    return data.tasks ?? [];
  }

  /**
   * Fetch a single task's result once it is ready. A 40401 status_code means
   * the task is not ready yet (or failed server-side) and is treated as
   * retryable - the polling loop in dataSource.ts relies on this to keep
   * polling rather than aborting on a not-yet-ready task.
   */
  async serpTaskGet(taskId: string): Promise<SerpTask> {
    const data = await this.request<{ tasks?: SerpTask[] }>(
      'GET',
      `/v3/serp/google/organic/task_get/regular/${taskId}`,
    );
    const task = data.tasks?.[0];
    if (!task) throw new DataForSeoError('Empty DataForSEO task response', false);
    if (task.status_code === 40401) {
      throw new DataForSeoError(`SERP task not ready/failed: ${task.status_message}`, true, undefined, task.status_code);
    }
    return task;
  }

  /** Single-keyword live organic SERP. */
  async serpLiveOrganic(keyword: string, opts: { locationCode?: number; languageCode?: string; depth?: number } = {}): Promise<SerpTaskResult> {
    const data = await this.request<{ tasks?: SerpTask[] }>('POST', '/v3/serp/google/organic/live/regular', [
      {
        keyword,
        location_code: opts.locationCode ?? 2840,
        language_code: opts.languageCode ?? 'en',
        depth: opts.depth ?? 20,
      },
    ]);
    const task = data.tasks?.[0];
    if (!task) throw new DataForSeoError('Empty live SERP response', false);
    const result = task.result?.[0];
    if (!result) throw new DataForSeoError('Live SERP has no result', false, task.status_code);
    return result;
  }

  // -- Keyword research (DataForSEO Labs) -----------------------------------

  /**
   * Keyword suggestions for one seed (DataForSEO Labs). include_serp_info is
   * off because the platform only stores the suggestion metrics, not the SERP
   * preview - keeping the response small and the quota spend low.
   */
  async keywordSuggestions(keyword: string, opts: { locationCode?: number; languageCode?: string; limit?: number } = {}): Promise<KeywordSuggestion[]> {
    const data = await this.request<{ tasks?: Array<{ result?: Array<{ items?: KeywordSuggestion[] }> }> }>(
      'POST',
      '/v3/dataforseo_labs/google/keyword_suggestions/live',
      [
        {
          keyword,
          location_code: opts.locationCode ?? 2840,
          language_code: opts.languageCode ?? 'en',
          limit: opts.limit ?? 20,
          include_serp_info: false,
        },
      ],
    );
    return data.tasks?.[0]?.result?.[0]?.items ?? [];
  }

  /**
   * Difficulty scores for a batch of keywords, keyed by keyword for O(1)
   * lookup. Rows the vendor skipped (no numeric difficulty) are simply absent
   * from the map - a caller that needs every keyword answered checks length
   * rather than trusting a positional array.
   */
  async keywordDifficulties(keywords: string[], opts: { locationCode?: number; languageCode?: string } = {}): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (keywords.length === 0) return map;
    const data = await this.request<{ tasks?: Array<{ result?: Array<{ items?: KeywordDifficultyItem[] }> }> }>(
      'POST',
      '/v3/dataforseo_labs/google/keyword_difficulty/live',
      keywords.map((keyword) => ({
        keyword,
        location_code: opts.locationCode ?? 2840,
        language_code: opts.languageCode ?? 'en',
      })),
    );
    for (const item of data.tasks?.[0]?.result?.[0]?.items ?? []) {
      const kw = item.keyword_data?.keyword;
      const diff = item.keyword_properties?.keyword_difficulty;
      if (kw && typeof diff === 'number') map.set(kw, diff);
    }
    return map;
  }
}
