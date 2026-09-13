/**
 * Keyword expansion service (KW4). A discover -> review -> select -> save
 * workflow that deliberately reuses the SAME `dataforseo_keyword_research` job
 * type as KW2: the executor branches on whether `params.methods` is present.
 * When it is absent the legacy KW2 path runs unchanged; when it is an array the
 * job is an expansion run whose bounded, merged candidates live on the job
 * result snapshot and are persisted ONLY through an explicit, verified Save.
 *
 * This module owns seed/method normalization, the run caps, the deterministic
 * merge and the safe run projection. It never talks to a provider, never reads
 * credentials and never lets a client supply provenance: the save path verifies
 * every keyword against the exact run snapshot and derives provenance here.
 */

import {
  KEYWORD_EXPANSION_MAX_LIMIT_PER_METHOD,
  KEYWORD_EXPANSION_MAX_RESULTS,
  KEYWORD_EXPANSION_MAX_SEEDS,
  KEYWORD_EXPANSION_METHODS,
  KEYWORD_EXPANSION_RELATED_DEFAULT_DEPTH,
  KEYWORD_EXPANSION_SEED_MAX_CHARS,
  type KeywordExpansionCandidateDto,
  type KeywordExpansionMethod,
  type KeywordExpansionRequest,
  type KeywordExpansionRunDto,
  type KeywordExpansionSaveDto,
  type KeywordExpansionStartDto,
  type KeywordQuery,
  type KeywordResearchResult,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { enqueueJob } from '../jobs/enqueue.js';
import type { JobRecord } from '../jobs/types.js';
import { SeoWriter, type ExpansionKeywordInput } from '../persistence/seoWriter.js';
import { KEYWORD_RESEARCH_JOB_TYPE, normalizeSeed } from './keywordResearchService.js';

/** The job_type an expansion run shares with legacy KW2. */
export const KEYWORD_EXPANSION_JOB_TYPE = KEYWORD_RESEARCH_JOB_TYPE;

/** Canonical method order, re-exported so callers share one source of truth. */
export { KEYWORD_EXPANSION_METHODS };

function isExpansionMethod(value: unknown): value is KeywordExpansionMethod {
  return typeof value === 'string' && (KEYWORD_EXPANSION_METHODS as readonly string[]).includes(value);
}

/**
 * One method's provider output for a run, tagged with the method and the seeds
 * it was run for (a multi-seed method such as ideas attributes all its seeds).
 */
export interface ExpansionMethodOutput {
  method: KeywordExpansionMethod;
  seeds: string[];
  results: KeywordResearchResult[];
}

/**
 * Check whether a job is a KW4 expansion run. The presence of a `methods` array
 * is the discriminator: a legacy KW2 job (no methods) is deliberately never an
 * expansion run, even when read through the expansion endpoints.
 */
function isExpansionJob(job: JobRecord): boolean {
  return job.job_type === KEYWORD_EXPANSION_JOB_TYPE && Array.isArray(job.params?.methods);
}

/** Normalize + validate the seed list for an expansion run. */
function normalizeExpansionSeeds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw ApiError.badRequest('Add at least one seed keyword to expand');
  }
  const seeds: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const seed = normalizeSeed(value);
    if (!seed) continue;
    if (seed.length > KEYWORD_EXPANSION_SEED_MAX_CHARS) {
      throw ApiError.badRequest(`Seed keywords must be ${KEYWORD_EXPANSION_SEED_MAX_CHARS} characters or fewer`);
    }
    if (!seeds.includes(seed)) seeds.push(seed);
  }
  if (seeds.length === 0) throw ApiError.badRequest('Add at least one seed keyword to expand');
  if (seeds.length > KEYWORD_EXPANSION_MAX_SEEDS) {
    throw ApiError.badRequest(`Expand at most ${KEYWORD_EXPANSION_MAX_SEEDS} seed keywords per run`);
  }
  return seeds;
}

/** Normalize + validate the requested method list, preserving canonical order. */
function normalizeExpansionMethods(raw: unknown): KeywordExpansionMethod[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw ApiError.badRequest('Select at least one expansion method');
  }
  const requested = new Set<KeywordExpansionMethod>();
  for (const value of raw) {
    if (!isExpansionMethod(value)) throw ApiError.badRequest(`Unknown expansion method '${String(value)}'`);
    requested.add(value);
  }
  return KEYWORD_EXPANSION_METHODS.filter((m) => requested.has(m));
}

/** Clamp the related depth to the vendor's 0-4 window, defaulting to 1. */
function normalizeRelatedDepth(raw: unknown): number {
  if (raw === undefined || raw === null) return KEYWORD_EXPANSION_RELATED_DEFAULT_DEPTH;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 4) {
    throw ApiError.badRequest('Related depth must be an integer between 0 and 4');
  }
  return raw;
}

/** Clamp the per-method provider limit to 1..KEYWORD_EXPANSION_MAX_LIMIT_PER_METHOD. */
function normalizeLimitPerMethod(raw: unknown): number {
  if (raw === undefined || raw === null) return KEYWORD_EXPANSION_MAX_LIMIT_PER_METHOD;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > KEYWORD_EXPANSION_MAX_LIMIT_PER_METHOD) {
    throw ApiError.badRequest(`Per-method limit must be between 1 and ${KEYWORD_EXPANSION_MAX_LIMIT_PER_METHOD}`);
  }
  return raw;
}

/** Validate the optional provider-side minimum volume (discovery filter). */
function normalizeProviderMinVolume(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw ApiError.badRequest('Minimum search volume must be a non-negative number');
  }
  return Math.floor(raw);
}

/**
 * Start one expansion run. Editor+ is enforced at the route; this still
 * re-validates every bound so the service is safe on any caller. The queued
 * job carries an explicit `methods` array - the discriminator that switches the
 * shared executor to the expansion snapshot path.
 */
export async function startKeywordExpansion(
  container: ServiceContainer,
  projectId: string,
  userId: string,
  request: KeywordExpansionRequest,
): Promise<KeywordExpansionStartDto> {
  const seeds = normalizeExpansionSeeds(request?.seeds);
  const methods = normalizeExpansionMethods(request?.methods);
  const relatedDepth = normalizeRelatedDepth(request?.relatedDepth);
  const limitPerMethod = normalizeLimitPerMethod(request?.limitPerMethod);
  const providerMinVolume = normalizeProviderMinVolume(request?.providerMinVolume);

  const params: Record<string, unknown> = { seeds, methods, relatedDepth, limitPerMethod };
  if (providerMinVolume !== undefined) params.providerMinVolume = providerMinVolume;

  const job = await enqueueJob(container, {
    projectId,
    userId,
    jobType: KEYWORD_EXPANSION_JOB_TYPE,
    params,
  });
  return { jobId: job.id, status: job.status, seeds, methods };
}

function methodOrder(method: KeywordExpansionMethod): number {
  const idx = KEYWORD_EXPANSION_METHODS.indexOf(method);
  return idx < 0 ? KEYWORD_EXPANSION_METHODS.length : idx;
}

/**
 * Deterministic merge/de-dupe of per-method results into one candidate list.
 *
 * De-dupe key is the trimmed, lowercased keyword. Methods and seeds are unioned
 * across the run. Metrics are taken from the FIRST non-null value in canonical
 * method order (suggestions, then related, then ideas) and later nulls never
 * overwrite a real value - so a re-run is reproducible and a metric can never
 * be "lost" to a method that happened to run later. Output is capped and sorted
 * by search volume descending (nulls last), then keyword ascending.
 */
export function mergeExpansionCandidates(outputs: ExpansionMethodOutput[]): KeywordExpansionCandidateDto[] {
  const ordered = [...outputs].sort((a, b) => methodOrder(a.method) - methodOrder(b.method));
  const byKey = new Map<string, KeywordExpansionCandidateDto>();
  const order: string[] = [];

  for (const out of ordered) {
    for (const r of out.results) {
      const keyword = typeof r.keyword === 'string' ? r.keyword.trim() : '';
      if (!keyword) continue;
      const key = keyword.toLowerCase();
      const intent = r.keyword_intents?.[0] ?? null;
      let candidate = byKey.get(key);
      if (!candidate) {
        candidate = {
          keyword,
          searchVolume: r.search_volume ?? null,
          difficulty: r.difficulty ?? null,
          cpc: r.cpc ?? null,
          competition: r.competition ?? null,
          intent,
          methods: [],
          seeds: [],
        };
        byKey.set(key, candidate);
        order.push(key);
      } else {
        candidate.searchVolume ??= r.search_volume ?? null;
        candidate.difficulty ??= r.difficulty ?? null;
        candidate.cpc ??= r.cpc ?? null;
        candidate.competition ??= r.competition ?? null;
        candidate.intent ??= intent;
      }
      if (!candidate.methods.includes(out.method)) candidate.methods.push(out.method);
      for (const seed of out.seeds) {
        if (!candidate.seeds.includes(seed)) candidate.seeds.push(seed);
      }
    }
  }

  const list = order.map((key) => byKey.get(key)!);
  list.sort((a, b) => {
    if (a.searchVolume == null && b.searchVolume == null) return a.keyword.localeCompare(b.keyword);
    if (a.searchVolume == null) return 1;
    if (b.searchVolume == null) return -1;
    if (b.searchVolume !== a.searchVolume) return b.searchVolume - a.searchVolume;
    return a.keyword.localeCompare(b.keyword);
  });
  return list.slice(0, KEYWORD_EXPANSION_MAX_RESULTS);
}

function compareVolume(a: KeywordExpansionCandidateDto, b: KeywordExpansionCandidateDto, dir: 'asc' | 'desc'): number {
  if (a.searchVolume == null && b.searchVolume == null) return a.keyword.localeCompare(b.keyword);
  if (a.searchVolume == null) return 1;
  if (b.searchVolume == null) return -1;
  if (a.searchVolume !== b.searchVolume) return dir === 'asc' ? a.searchVolume - b.searchVolume : b.searchVolume - a.searchVolume;
  return a.keyword.localeCompare(b.keyword);
}

/**
 * Apply result-view filters to an already bounded run snapshot. These never
 * start a provider call; they only narrow what is shown. A `method` filter
 * keeps candidates surfaced by that method; `minVolume` excludes null volumes
 * (an unknown volume cannot satisfy a minimum) rather than treating them as 0.
 */
export function applyKeywordQuery(
  candidates: KeywordExpansionCandidateDto[],
  query: KeywordQuery = {},
): KeywordExpansionCandidateDto[] {
  let out = candidates;
  if (query.method) out = out.filter((c) => c.methods.includes(query.method!));
  if (query.minVolume != null) out = out.filter((c) => c.searchVolume != null && c.searchVolume >= query.minVolume!);
  if (query.sort === 'volume_asc') return [...out].sort((a, b) => compareVolume(a, b, 'asc'));
  if (query.sort === 'volume_desc') return [...out].sort((a, b) => compareVolume(a, b, 'desc'));
  if (query.sort === 'keyword_asc') return [...out].sort((a, b) => a.keyword.localeCompare(b.keyword));
  return out;
}

/** The seeds a run was started for, preferring params then the stored result. */
function seedsFromJob(job: JobRecord): string[] {
  const raw = job.params?.seeds ?? job.result?.seeds;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === 'string' && value) out.push(value);
    if (out.length >= KEYWORD_EXPANSION_MAX_SEEDS) break;
  }
  return out;
}

/** The methods a run was started with, in canonical order. */
function methodsFromJob(job: JobRecord): KeywordExpansionMethod[] {
  const raw = job.params?.methods;
  if (!Array.isArray(raw)) return [];
  const requested = new Set(raw.filter(isExpansionMethod));
  return KEYWORD_EXPANSION_METHODS.filter((m) => requested.has(m));
}

/** The per-method status map stored on a completed run. */
function methodStatusFromResult(job: JobRecord): Record<string, { status: 'success' | 'failed' | 'skipped'; count: number }> {
  const raw = job.result?.methodStatus;
  const out: Record<string, { status: 'success' | 'failed' | 'skipped'; count: number }> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [method, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isExpansionMethod(method) || !value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const status = row.status === 'success' || row.status === 'failed' || row.status === 'skipped' ? row.status : 'failed';
    const count = typeof row.count === 'number' && Number.isFinite(row.count) && row.count >= 0 ? row.count : 0;
    out[method] = { status, count };
  }
  return out;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Project the bounded, merged candidates stored on a completed run snapshot. */
function candidatesFromResult(job: JobRecord): KeywordExpansionCandidateDto[] {
  const raw = job.result?.candidates;
  if (!Array.isArray(raw)) return [];
  const out: KeywordExpansionCandidateDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.keyword !== 'string' || !row.keyword) continue;
    const methods = Array.isArray(row.methods) ? row.methods.filter(isExpansionMethod) : [];
    const seeds = Array.isArray(row.seeds) ? row.seeds.filter((s): s is string => typeof s === 'string' && !!s) : [];
    out.push({
      keyword: row.keyword,
      searchVolume: nullableNumber(row.searchVolume),
      difficulty: nullableNumber(row.difficulty),
      cpc: nullableNumber(row.cpc),
      competition: nullableString(row.competition),
      intent: nullableString(row.intent),
      methods,
      seeds,
    });
    if (out.length >= KEYWORD_EXPANSION_MAX_RESULTS) break;
  }
  return out;
}

/**
 * Read exactly one expansion run by its job id, scoped to the project. A job
 * from another project, of another type, or a legacy KW2 run (no methods) is
 * reported as not found. A failed run carries only a safe, generic message -
 * never raw provider bodies, URLs or credentials.
 */
export async function readKeywordExpansionRun(
  container: ServiceContainer,
  projectId: string,
  jobId: string,
  query: KeywordQuery = {},
): Promise<KeywordExpansionRunDto> {
  const job = await container.jobStore.get(jobId);
  if (!job || job.project_id !== projectId || !isExpansionJob(job)) {
    throw ApiError.notFound('Keyword expansion run not found');
  }
  const completed = job.status === 'completed';
  const all = completed ? candidatesFromResult(job) : [];
  const candidates = applyKeywordQuery(all, query);
  return {
    jobId: job.id,
    status: job.status,
    seeds: seedsFromJob(job),
    methods: methodsFromJob(job),
    methodStatus: completed ? methodStatusFromResult(job) : {},
    candidates,
    count: candidates.length,
    error: job.status === 'failed' ? 'Keyword expansion failed. Please try again.' : null,
    createdAt: job.queued_at,
    completedAt: job.completed_at,
  };
}

/**
 * Explicitly save selected candidates into the shared keyword store. The client
 * sends keyword strings only; each one is verified against THIS run's snapshot
 * (404/409/400 otherwise) and provenance is derived server-side. A keyword that
 * is not part of the run is never written.
 */
export async function saveKeywordExpansionSelection(
  container: ServiceContainer,
  projectId: string,
  jobId: string,
  rawKeywords: unknown,
): Promise<KeywordExpansionSaveDto> {
  if (!Array.isArray(rawKeywords) || rawKeywords.length === 0) {
    throw ApiError.badRequest('Select at least one keyword to save');
  }
  if (rawKeywords.length > KEYWORD_EXPANSION_MAX_RESULTS) {
    throw ApiError.badRequest(`Save at most ${KEYWORD_EXPANSION_MAX_RESULTS} keywords at a time`);
  }
  const job = await container.jobStore.get(jobId);
  if (!job || job.project_id !== projectId || !isExpansionJob(job)) {
    throw ApiError.notFound('Keyword expansion run not found');
  }
  if (job.status !== 'completed') {
    throw ApiError.conflict('This keyword expansion run is not complete yet');
  }

  const candidates = candidatesFromResult(job);
  const byKey = new Map<string, KeywordExpansionCandidateDto>();
  for (const candidate of candidates) byKey.set(candidate.keyword.trim().toLowerCase(), candidate);

  const selected: KeywordExpansionCandidateDto[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const value of rawKeywords) {
    if (typeof value !== 'string') {
      invalid.push(String(value));
      continue;
    }
    const key = value.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    const candidate = byKey.get(key);
    if (!candidate) {
      invalid.push(value.trim());
      continue;
    }
    selected.push(candidate);
  }
  if (invalid.length > 0) {
    throw ApiError.badRequest('Some keywords are not part of this run', { invalid });
  }
  if (selected.length === 0) {
    throw ApiError.badRequest('Select at least one keyword to save');
  }

  const relatedDepth = normalizeRelatedDepth(job.params?.relatedDepth);
  const rows: ExpansionKeywordInput[] = selected.map((candidate) => {
    const meta: Record<string, unknown> = {
      discovered_via: 'keyword_expansion',
      run_job_id: job.id,
      methods: candidate.methods,
      seeds: candidate.seeds,
    };
    if (candidate.methods.includes('related')) meta.related_depth = relatedDepth;
    return {
      keyword: candidate.keyword,
      volume: candidate.searchVolume,
      difficulty: candidate.difficulty,
      cpc: candidate.cpc,
      competition: candidate.competition,
      intent: candidate.intent,
      meta,
    };
  });

  await new SeoWriter(container.sb).persistExpansionKeywords(projectId, rows);
  return { saved: rows.length, skipped };
}
