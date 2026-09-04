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
 */

import { delay } from '../../util.js';

const BASE = 'https://api.dataforseo.com';

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

export class AuthError extends DataForSeoError {
  constructor(message: string) {
    super(message, false, 401);
    this.name = 'AuthError';
  }
}

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

export interface SerpTask {
  id: string;
  keyword?: string;
  location_code?: number;
  language_code?: string;
  status_code?: number;
  status_message?: string;
  result?: SerpTaskResult[];
}

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

interface KeywordInfo {
  search_volume?: number;
  cpc?: number;
  competition?: number;
  monthly_searches?: Array<{ year: number; month: number; search_volume: number }>;
}

export interface KeywordDifficultyItem {
  keyword_data?: { keyword?: string };
  keyword_properties?: { keyword_difficulty?: number; keyword_difficulty_info?: { level?: string } };
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

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

  private async pace() {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    if (this.nextSlotAt > now) {
      await delay(this.nextSlotAt - now);
    }
    this.nextSlotAt = Math.max(this.nextSlotAt, Date.now()) + this.minIntervalMs;
  }

  private classify(message: string, status: number | undefined, code: number | undefined): DataForSeoError {
    if (status === 401 || status === 403) return new AuthError(`DataForSEO authentication failed (${status})`);
    if (code === 9001 || code === 9002 || code === 9003 || code === 90203 || code === 90206) {
      return new DataForSeoError(`DataForSEO quota/balance error: ${message}`, false, status, code);
    }
    const retryable = status !== undefined ? RETRYABLE_STATUS.has(status) : false;
    return new DataForSeoError(message, retryable, status, code);
  }

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
