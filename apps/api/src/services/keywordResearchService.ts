/**
 * Keyword research service (KW2). One explicit seed keyword starts exactly one
 * background job on the existing `dataforseo_keyword_research` execution path;
 * the run's bounded, normalized results are stored on that job row
 * (`seo_sync_jobs.result`), so a run is identified by its job id - never by
 * guessing from the shared `seo_keywords` store. This module owns the seed
 * normalization and the safe run projection; it never talks to a provider and
 * never reads credentials.
 */

import {
  KEYWORD_RESEARCH_RUN_MAX_KEYWORDS,
  KEYWORD_RESEARCH_SEED_MAX_CHARS,
  type KeywordResearchKeywordDto,
  type KeywordResearchRunDto,
  type KeywordResearchStartDto,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { enqueueJob } from '../jobs/enqueue.js';
import type { JobRecord } from '../jobs/types.js';

/** The one job_type that backs a keyword research run. */
export const KEYWORD_RESEARCH_JOB_TYPE = 'dataforseo_keyword_research';

/** Trim a raw seed and collapse internal whitespace runs to single spaces. */
export function normalizeSeed(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Start one research run for one seed. Editor+ is enforced at the route; this
 * still re-validates the seed so the boundary is safe on every caller.
 */
export async function startKeywordResearch(
  container: ServiceContainer,
  projectId: string,
  userId: string,
  rawSeed: string,
): Promise<KeywordResearchStartDto> {
  const seed = normalizeSeed(rawSeed);
  if (!seed) throw ApiError.badRequest('Enter a keyword to research');
  if (seed.length > KEYWORD_RESEARCH_SEED_MAX_CHARS) {
    throw ApiError.badRequest(`Seed keyword must be ${KEYWORD_RESEARCH_SEED_MAX_CHARS} characters or fewer`);
  }
  const job = await enqueueJob(container, {
    projectId,
    userId,
    jobType: KEYWORD_RESEARCH_JOB_TYPE,
    params: { seeds: [seed] },
  });
  return { jobId: job.id, status: job.status, seed };
}

/** The seed a run was started with, preferring params but falling back to result. */
function seedFromJob(job: JobRecord): string {
  const seeds = job.params?.seeds ?? job.params?.keywords;
  if (Array.isArray(seeds) && typeof seeds[0] === 'string') return seeds[0];
  const resultSeed = job.result?.seed;
  return typeof resultSeed === 'string' ? resultSeed : '';
}

/** Project the bounded, normalized keyword rows stored on a completed run. */
function keywordsFromResult(job: JobRecord): KeywordResearchKeywordDto[] {
  const raw = job.result?.keywords;
  if (!Array.isArray(raw)) return [];
  const out: KeywordResearchKeywordDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.keyword !== 'string' || !row.keyword) continue;
    out.push({
      keyword: row.keyword,
      searchVolume: typeof row.searchVolume === 'number' ? row.searchVolume : null,
      difficulty: typeof row.difficulty === 'number' ? row.difficulty : null,
      cpc: typeof row.cpc === 'number' ? row.cpc : null,
    });
    if (out.length >= KEYWORD_RESEARCH_RUN_MAX_KEYWORDS) break;
  }
  return out;
}

/**
 * Read exactly one research run by its job id, scoped to the project. A job
 * from another project (or of another type) is reported as not found so runs
 * are never crossed. A failed run carries only a safe, generic message - never
 * raw provider bodies, URLs or credentials.
 */
export async function readKeywordResearchRun(
  container: ServiceContainer,
  projectId: string,
  jobId: string,
): Promise<KeywordResearchRunDto> {
  const job = await container.jobStore.get(jobId);
  if (!job || job.project_id !== projectId || job.job_type !== KEYWORD_RESEARCH_JOB_TYPE) {
    throw ApiError.notFound('Research run not found');
  }
  const completed = job.status === 'completed';
  const keywords = completed ? keywordsFromResult(job) : [];
  const rawCount = Number(job.result?.results);
  return {
    jobId: job.id,
    seed: seedFromJob(job),
    status: job.status,
    results: completed ? (Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : keywords.length) : 0,
    keywords,
    error: job.status === 'failed' ? 'Keyword research failed. Please try again.' : null,
    createdAt: job.queued_at,
    completedAt: job.completed_at,
  };
}
