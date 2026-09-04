/**
 * DataForSEO as a pluggable SeoDataSource.
 *
 * All DataForSEO access funnels through DataForSeoClient (auth, retries, rate
 * limits, task APIs). This adapter only decides *which* DataForSEO features map
 * to platform capabilities and normalizes results via normalize.ts.
 */

import type {
  CompetitorItem,
  KeywordResearchResult,
  ProviderContext,
  ProviderDeps,
  SeoDataSource,
  SerpItem,
  SerpSnapshot,
} from '@seo/contracts';
import { ApiError } from '../../apiErrors.js';
import { DataForSeoClient, type SerpTask } from './dataForSeoClient.js';
import {
  keywordOfTask,
  normalizeSerpItems,
  normalizeSuggestion,
  resultOfTask,
  urlBelongsToDomain,
} from './normalize.js';
import { delay } from '../../util.js';

export interface SerpFetchOutcome {
  keyword: string;
  engine: string;
  fetchedAt: string;
  items: SerpItem[];
}

export const DATAFORSEO_CRED_KEYS = {
  login: 'dataforseo_login',
  password: 'dataforseo_password',
  base64: 'dataforseo_base64',
} as const;

const LOCATION_CODE = 2840; // US
const LANGUAGE_CODE = 'en';
const TASK_BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 5000;
const TASK_TIMEOUT_MS = 240_000;

export class DataForSeoDataSource implements SeoDataSource {
  readonly id = 'dataforseo';
  readonly name = 'DataForSEO';
  readonly description = 'SERP tracking, keyword research and competitor data';
  readonly capabilities = ['keywords', 'rankings', 'serp', 'competitors'] as const;

  constructor(private readonly deps: ProviderDeps) {}

  private async clientFor(ctx: ProviderContext): Promise<DataForSeoClient> {
    let login = await ctx.credentials.get(DATAFORSEO_CRED_KEYS.login);
    let password = await ctx.credentials.get(DATAFORSEO_CRED_KEYS.password);
    const storedToken = await ctx.credentials.get(DATAFORSEO_CRED_KEYS.base64);
    if (storedToken) {
      return new DataForSeoClient({ basicToken: storedToken });
    }
    const envToken = this.deps.config.DATAFORSEO_BASE64 ?? null;
    if (envToken) {
      return new DataForSeoClient({ basicToken: envToken });
    }
    if (!login || !password) {
      login = this.deps.config.DATAFORSEO_LOGIN ?? null;
      password = this.deps.config.DATAFORSEO_PASSWORD ?? null;
    }
    if (!login || !password) {
      throw ApiError.notConfigured(
        'DataForSEO is not configured. Add credentials in Integrations or set DATAFORSEO_BASE64 (or DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD) on the server.',
      );
    }
    return new DataForSeoClient({ login, password });
  }

  // -- connection lifecycle --------------------------------------------------

  async connect(ctx: ProviderContext) {
    const client = await this.clientFor(ctx);
    await client.serpTasksReady(); // cheap authenticated call -> validates credentials
    const login = await ctx.credentials.get(DATAFORSEO_CRED_KEYS.login);
    return {
      ok: true,
      message: 'Connected to DataForSEO',
      external: login ? [{ id: login, label: login }] : [],
    };
  }

  async disconnect(ctx: ProviderContext): Promise<void> {
    await ctx.credentials.delete(DATAFORSEO_CRED_KEYS.login);
    await ctx.credentials.delete(DATAFORSEO_CRED_KEYS.password);
  }

  async testConnection(ctx: ProviderContext): Promise<{ ok: boolean; message?: string }> {
    const client = await this.clientFor(ctx);
    await client.serpTasksReady();
    return { ok: true, message: 'DataForSEO credentials are valid' };
  }

  // -- capability: keyword research ------------------------------------------

  async researchKeywords(ctx: ProviderContext, seeds: string[]): Promise<KeywordResearchResult[]> {
    const client = await this.clientFor(ctx);
    const results: KeywordResearchResult[] = [];
    for (const seed of seeds.slice(0, 20)) {
      const suggestions = await client.keywordSuggestions(seed, {
        locationCode: LOCATION_CODE,
        languageCode: LANGUAGE_CODE,
        limit: 25,
      });
      for (const s of suggestions) {
        const normalized = normalizeSuggestion(s);
        if (normalized) results.push(normalized);
      }
    }
    return results;
  }

  // -- capability: SERP / competitors -----------------------------------------

  /** Live organic SERP per keyword (good for small, interactive retrievals). */
  async fetchLiveSerp(ctx: ProviderContext, keywords: string[], opts: { depth?: number } = {}): Promise<SerpFetchOutcome[]> {
    const client = await this.clientFor(ctx);
    const outcomes: SerpFetchOutcome[] = [];
    for (const keyword of keywords.slice(0, 50)) {
      const result = await client.serpLiveOrganic(keyword, {
        locationCode: LOCATION_CODE,
        languageCode: LANGUAGE_CODE,
        depth: opts.depth ?? 20,
      });
      outcomes.push({
        keyword: result.keyword ?? keyword,
        engine: 'google',
        fetchedAt: new Date().toISOString(),
        items: normalizeSerpItems(result.items),
      });
      await delay(600);
    }
    return outcomes;
  }

  /**
   * Task-based organic SERP for larger keyword sets: posts batches, polls
   * tasks_ready, collects results. onProgress can surface completion to a job.
   */
  async fetchTaskSerp(
    ctx: ProviderContext,
    keywords: string[],
    opts: { onProgress?: (done: number, total: number) => void; abortSignal?: AbortSignal } = {},
  ): Promise<SerpFetchOutcome[]> {
    const client = await this.clientFor(ctx);
    const map = new Map<string, { task: SerpTask }>();
    for (let i = 0; i < keywords.length; i += TASK_BATCH_SIZE) {
      const batch = keywords.slice(i, i + TASK_BATCH_SIZE);
      const tasks = await client.postSerpOrganicTasks(
        batch.map((keyword) => ({
          keyword,
          location_code: LOCATION_CODE,
          language_code: LANGUAGE_CODE,
          depth: 30,
        })),
      );
      for (const task of tasks) {
        map.set(task.id, { task });
      }
    }
    const outcomes = await pollUntilDone(client, map, opts);
    opts.onProgress?.(outcomes.length, keywords.length);
    return outcomes;
  }

  async getSerp(): Promise<never[]> {
    // Live SERP flows through fetchLiveSerp/fetchTaskSerp (concrete adapter API).
    return [];
  }

  async getCompetitors(ctx: ProviderContext, keywords: string[]): Promise<CompetitorItem[]> {
    const ownDomain = (ctx.config.target_domain as string | undefined) ?? null;
    const outcomes = await this.fetchLiveSerp(ctx, keywords, { depth: 20 });
    const competitors: CompetitorItem[] = [];
    for (const outcome of outcomes) {
      for (const item of outcome.items) {
        if (ownDomain && urlBelongsToDomain(item.url, ownDomain)) continue;
        if (!item.domain) continue;
        competitors.push({
          domain: item.domain,
          url: item.url,
          title: item.title,
          description: item.description,
          position: item.position,
          keyword: outcome.keyword,
          serp_item: item,
        });
      }
    }
    return competitors;
  }

  // -- interface stubs (unused by generic core for this provider) -------------

  async getKeywords(): Promise<never[]> {
    return [];
  }
  async getPages(): Promise<never[]> {
    return [];
  }
  async getPerformance() {
    return { daily: [], keywords: [], pages: [] };
  }
  async getRankings(): Promise<never[]> {
    // Rank tracking flows through the dedicated rank-sync executor.
    return [];
  }
}

async function pollUntilDone(
  client: DataForSeoClient,
  map: Map<string, { task: SerpTask }>,
  opts: { abortSignal?: AbortSignal },
): Promise<SerpFetchOutcome[]> {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  const outcomes: SerpFetchOutcome[] = [];
  const failed = new Map<string, string>();

  while (map.size > 0 && Date.now() < deadline) {
    if (opts.abortSignal?.aborted) {
      throw new ApiError(499, 'aborted', 'Job aborted while polling SERP tasks');
    }
    await delay(POLL_INTERVAL_MS);
    const ready = await client.serpTasksReady();
    for (const readyTask of ready) {
      const entry = map.get(readyTask.id);
      if (!entry) continue;
      try {
        const task = await client.serpTaskGet(readyTask.id);
        const keyword = keywordOfTask(task) || (entry.task.keyword as string) || '';
        const result = resultOfTask(task);
        outcomes.push({
          keyword,
          engine: 'google',
          fetchedAt: new Date().toISOString(),
          items: normalizeSerpItems(result?.items),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'task failed';
        if ((err as { retryable?: boolean }).retryable === false) {
          failed.set(readyTask.id, message);
        }
        // retryable failures are simply retried on the next readiness poll.
      } finally {
        map.delete(readyTask.id);
      }
    }
  }

  if (map.size > 0) {
    throw new ApiError(504, 'provider_timeout', `DataForSEO SERP tasks timed out with ${map.size} pending`);
  }
  return outcomes;
}
