/**
 * Competitor research service (KW3). Domain-based competitor discovery and a
 * competitor keyword gap both run on the one existing `competitor_research` job
 * type - one executor, two explicit modes (`discover` | `gap`). The run's
 * bounded, normalized result lives on that job row (`seo_sync_jobs.result`), so
 * a run is identified by its job id and never by guessing from the shared
 * keyword store. This module owns domain normalization, the run caps and the
 * safe run projection; it never talks to a provider and never reads credentials.
 */

import {
  COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS,
  COMPETITOR_RESEARCH_MAX_CANDIDATES,
  COMPETITOR_RESEARCH_MAX_COMPETITORS,
  COMPETITOR_RESEARCH_RUN_MAX_GAPS,
  type CompetitorCandidateDto,
  type CompetitorDiscoveryStartDto,
  type CompetitorGapDto,
  type CompetitorGapStartDto,
  type CompetitorResearchMode,
  type CompetitorResearchRunDto,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { enqueueJob } from '../jobs/enqueue.js';
import type { JobRecord } from '../jobs/types.js';
import { siteHostOf } from './contentIntelligence.js';

/** The one job_type that backs both competitor-research modes. */
export const COMPETITOR_RESEARCH_JOB_TYPE = 'competitor_research';

/** A bare-hostname domain (labels of a-z0-9/-, at least one dot, real TLD). */
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Normalize a user/domain value to a bare hostname: strip scheme, userinfo,
 * path/query/fragment, port, a leading www and casing. Returns '' when nothing
 * usable remains so callers can reject rather than enqueue a meaningless target.
 */
export function normalizeDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^/@]*@/, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

/** Normalize and validate a domain, throwing a 400 the edge can surface. */
export function assertDomain(raw: string): string {
  const domain = normalizeDomain(raw);
  if (!domain) throw ApiError.badRequest('A domain is required');
  if (domain.length > COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS || !DOMAIN_PATTERN.test(domain)) {
    throw ApiError.badRequest('Enter a valid domain, e.g. example.com');
  }
  return domain;
}

/**
 * The hostname of the project's linked Search Console property, if any. Since
 * the property registry went account-scoped, a project references its property
 * through `seo_project_properties`; `site_url` covers both url-prefix and
 * `sc-domain:` forms and is normalized to a bare host here. Returns null when
 * the project has not linked a property, so callers can fall through honestly.
 */
async function linkedPropertyDomain(container: ServiceContainer, projectId: string): Promise<string | null> {
  const { data: link, error: linkError } = await container.sb
    .from('seo_project_properties')
    .select('property_id')
    .eq('project_id', projectId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (linkError) throw new ApiError(500, 'storage_error', 'Could not read the project Search Console property');
  const propertyId = (link as { property_id?: string } | null)?.property_id;
  if (!propertyId) return null;

  const { data: property, error: propertyError } = await container.sb
    .from('seo_gsc_properties')
    .select('site_url')
    .eq('id', propertyId)
    .maybeSingle();
  if (propertyError) throw new ApiError(500, 'storage_error', 'Could not read the project Search Console property');
  const siteUrl = (property as { site_url?: string } | null)?.site_url;
  return siteUrl ? siteHostOf(siteUrl) : null;
}

/**
 * The project's own target domain: an explicitly supplied one wins, otherwise
 * the domain of the project's linked Search Console property (the same domain
 * all of its GSC data comes from), otherwise a primary (else first)
 * `seo_domains` row. A project with neither is an honest 400 - never a guess.
 */
export async function resolveProjectDomain(
  container: ServiceContainer,
  projectId: string,
  preferred?: string,
): Promise<string> {
  if (preferred && preferred.trim()) return assertDomain(preferred);
  const linked = await linkedPropertyDomain(container, projectId);
  if (linked) return assertDomain(linked);
  const { data, error } = await container.sb
    .from('seo_domains')
    .select('domain')
    .eq('project_id', projectId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new ApiError(500, 'storage_error', 'Could not read the project domain');
  const domain = (data as { domain?: string } | null)?.domain;
  if (!domain) {
    throw ApiError.badRequest('Connect a Search Console property to this project before finding competitors');
  }
  return assertDomain(domain);
}

/**
 * Start one competitor discovery run for the project domain (or an explicit
 * override). Discovery is capped to a single cheap Labs task; the user chooses
 * which candidates to compare afterwards.
 */
export async function startCompetitorDiscovery(
  container: ServiceContainer,
  projectId: string,
  userId: string,
  rawDomain?: string,
): Promise<CompetitorDiscoveryStartDto> {
  const domain = await resolveProjectDomain(container, projectId, rawDomain);
  const job = await enqueueJob(container, {
    projectId,
    userId,
    jobType: COMPETITOR_RESEARCH_JOB_TYPE,
    params: { mode: 'discover', domain },
  });
  return { jobId: job.id, status: job.status, mode: 'discover', domain };
}

/**
 * Start one keyword-gap analysis for up to the platform maximum of competitors.
 * Domains are normalized, de-duplicated and never allowed to include the target
 * itself; the run cap is enforced here so an over-eager caller cannot multiply
 * provider cost.
 */
export async function startCompetitorGap(
  container: ServiceContainer,
  projectId: string,
  userId: string,
  rawDomain: string | undefined,
  competitors: string[],
): Promise<CompetitorGapStartDto> {
  const domain = await resolveProjectDomain(container, projectId, rawDomain);
  if (!Array.isArray(competitors) || competitors.length === 0) {
    throw ApiError.badRequest('Select at least one competitor to analyze');
  }
  const normalized: string[] = [];
  for (const raw of competitors) {
    const candidate = assertDomain(raw);
    if (candidate === domain) throw ApiError.badRequest('A competitor cannot be your own domain');
    if (!normalized.includes(candidate)) normalized.push(candidate);
  }
  if (normalized.length > COMPETITOR_RESEARCH_MAX_COMPETITORS) {
    throw ApiError.badRequest(`Select at most ${COMPETITOR_RESEARCH_MAX_COMPETITORS} competitors`);
  }
  const job = await enqueueJob(container, {
    projectId,
    userId,
    jobType: COMPETITOR_RESEARCH_JOB_TYPE,
    params: { mode: 'gap', domain, competitors: normalized },
  });
  return { jobId: job.id, status: job.status, mode: 'gap', domain, competitors: normalized };
}

/** The mode a run belongs to, preferring params then the stored result. */
function modeFromJob(job: JobRecord): CompetitorResearchMode {
  const paramMode = job.params?.mode;
  if (paramMode === 'discover' || paramMode === 'gap') return paramMode;
  return job.result?.mode === 'gap' ? 'gap' : 'discover';
}

/** The target domain a run was started for, preferring params then result. */
function domainFromJob(job: JobRecord): string {
  const fromParams = job.params?.domain;
  if (typeof fromParams === 'string') return fromParams;
  const fromResult = job.result?.domain;
  return typeof fromResult === 'string' ? fromResult : '';
}

/** Normalize a min-volume filter to a finite non-negative integer or null. */
function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Project the bounded competitor candidates stored on a completed run. */
function candidatesFromResult(job: JobRecord): CompetitorCandidateDto[] {
  const raw = job.result?.competitors;
  if (!Array.isArray(raw)) return [];
  const out: CompetitorCandidateDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.domain !== 'string' || !row.domain) continue;
    out.push({
      domain: row.domain,
      sharedKeywords: nullableNumber(row.sharedKeywords),
      keywordsCount: nullableNumber(row.keywordsCount),
      avgPosition: nullableNumber(row.avgPosition),
      etv: nullableNumber(row.etv),
    });
    if (out.length >= COMPETITOR_RESEARCH_MAX_CANDIDATES) break;
  }
  return out;
}

/** Project the bounded gap rows stored on a completed run. */
function gapsFromResult(job: JobRecord): CompetitorGapDto[] {
  const raw = job.result?.gaps;
  if (!Array.isArray(raw)) return [];
  const out: CompetitorGapDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.keyword !== 'string' || !row.keyword) continue;
    if (typeof row.competitorDomain !== 'string' || !row.competitorDomain) continue;
    out.push({
      keyword: row.keyword,
      searchVolume: nullableNumber(row.searchVolume),
      difficulty: nullableNumber(row.difficulty),
      cpc: nullableNumber(row.cpc),
      competitorDomain: row.competitorDomain,
      position: nullableNumber(row.position),
    });
    if (out.length >= COMPETITOR_RESEARCH_RUN_MAX_GAPS) break;
  }
  return out;
}

/** The competitor domains a gap run was started for. */
function selectedCompetitorsFromJob(job: JobRecord): string[] {
  const raw = job.params?.competitors;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === 'string' && value) out.push(value);
    if (out.length >= COMPETITOR_RESEARCH_MAX_COMPETITORS) break;
  }
  return out;
}

/**
 * Read exactly one competitor research run by its job id, scoped to the
 * project. A job from another project (or of another type) is reported as not
 * found so runs are never crossed. A failed run carries only a safe, generic
 * message - never raw provider bodies, URLs or credentials.
 */
export async function readCompetitorResearchRun(
  container: ServiceContainer,
  projectId: string,
  jobId: string,
): Promise<CompetitorResearchRunDto> {
  const job = await container.jobStore.get(jobId);
  if (!job || job.project_id !== projectId || job.job_type !== COMPETITOR_RESEARCH_JOB_TYPE) {
    throw ApiError.notFound('Competitor research run not found');
  }
  const mode = modeFromJob(job);
  const completed = job.status === 'completed';
  const candidates = completed && mode === 'discover' ? candidatesFromResult(job) : [];
  const gaps = completed && mode === 'gap' ? gapsFromResult(job) : [];
  const rawCount = job.result?.count;
  const count = completed
    ? (typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount >= 0
        ? rawCount
        : mode === 'discover'
          ? candidates.length
          : gaps.length)
    : 0;
  return {
    jobId: job.id,
    mode,
    status: job.status,
    domain: domainFromJob(job),
    candidates,
    selectedCompetitors: selectedCompetitorsFromJob(job),
    gaps,
    count,
    error: job.status === 'failed' ? 'Competitor research failed. Please try again.' : null,
    createdAt: job.queued_at,
    completedAt: job.completed_at,
  };
}
