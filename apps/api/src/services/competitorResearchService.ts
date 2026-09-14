/**
 * Competitor research service (KW3). Domain-based competitor discovery and a
 * competitor keyword gap both run on the one existing `competitor_research` job
 * type - one executor, two explicit modes (`discover` | `gap`). The run's own
 * bounded, normalized result lives on that job row (`seo_sync_jobs.result`), so
 * a run is identified by its job id and never by guessing from the shared
 * keyword store.
 *
 * Since KW4.5 the executor also writes a reusable, project-scoped source
 * snapshot for each mode. Starting a run reuses a *fresh* snapshot for the same
 * canonical scope and makes no provider call; a stale/missing snapshot (or an
 * explicit `refresh`) enqueues the provider job. This module owns domain
 * normalization, the run caps, snapshot reuse and the safe projections; it never
 * talks to a provider and never reads credentials.
 */

import {
  COMPETITOR_RESEARCH_MAX_COMPETITORS,
  type CompetitorCandidateDto,
  type CompetitorDiscoveryStartDto,
  type CompetitorGapDto,
  type CompetitorGapStartDto,
  type CompetitorResearchMode,
  type CompetitorResearchRunDto,
  type SourceSnapshotDto,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { enqueueJob } from '../jobs/enqueue.js';
import type { JobRecord } from '../jobs/types.js';
import { siteHostOf } from './contentIntelligence.js';
import { assertDomain, normalizeDomain } from './domain.js';
import { competitorDiscoveryScope, competitorGapScope } from './sourceScope.js';
import {
  projectCandidateRows,
  projectGapRows,
  readSourceSnapshot,
  toSourceSnapshotDto,
} from './sourceSnapshotService.js';

export { assertDomain, normalizeDomain } from './domain.js';

/** The one job_type that backs both competitor-research modes. */
export const COMPETITOR_RESEARCH_JOB_TYPE = 'competitor_research';

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

/** Options shared by both start paths. `refresh` forces a paid provider run. */
export interface CompetitorStartOptions {
  refresh?: boolean;
}

/**
 * Return the current snapshot for a scope only when it is `fresh` (no provider
 * call needed). `due`/`stale` snapshots are deliberately not auto-reused: an
 * explicit start is the moment the user chose to refresh stale data.
 */
async function freshSnapshot(
  container: ServiceContainer,
  projectId: string,
  type: 'competitor_discovery' | 'competitor_gap',
  scope: Record<string, unknown>,
): Promise<SourceSnapshotDto | null> {
  const record = await readSourceSnapshot(container, projectId, type, scope);
  if (!record) return null;
  const dto = toSourceSnapshotDto(record);
  return dto.freshness.state === 'fresh' ? dto : null;
}

/**
 * Normalize, validate and de-duplicate a competitor list against the target
 * domain. Shared by the start path and the current-snapshot read so the two can
 * never disagree about what a scope contains.
 */
function normalizeCompetitors(domain: string, competitors: unknown): string[] {
  if (!Array.isArray(competitors) || competitors.length === 0) {
    throw ApiError.badRequest('Select at least one competitor to analyze');
  }
  const normalized: string[] = [];
  for (const raw of competitors) {
    if (typeof raw !== 'string') continue;
    const candidate = assertDomain(raw);
    if (candidate === domain) throw ApiError.badRequest('A competitor cannot be your own domain');
    if (!normalized.includes(candidate)) normalized.push(candidate);
  }
  if (normalized.length === 0) throw ApiError.badRequest('Select at least one competitor to analyze');
  if (normalized.length > COMPETITOR_RESEARCH_MAX_COMPETITORS) {
    throw ApiError.badRequest(`Select at most ${COMPETITOR_RESEARCH_MAX_COMPETITORS} competitors`);
  }
  return normalized;
}

/**
 * Start one competitor discovery run for the project domain (or an explicit
 * override). Discovery is capped to a single cheap Labs task; the user chooses
 * which candidates to compare afterwards. A fresh snapshot for the same scope
 * is reused instead of paying for an identical provider call.
 */
export async function startCompetitorDiscovery(
  container: ServiceContainer,
  projectId: string,
  userId: string,
  rawDomain?: string,
  opts: CompetitorStartOptions = {},
): Promise<CompetitorDiscoveryStartDto> {
  const domain = await resolveProjectDomain(container, projectId, rawDomain);
  const scope = competitorDiscoveryScope({ domain });
  if (!opts.refresh) {
    const reused = await freshSnapshot(container, projectId, 'competitor_discovery', scope);
    if (reused) {
      return { jobId: null, status: 'completed', mode: 'discover', domain, reused: true, snapshotId: reused.id };
    }
  }
  const job = await enqueueJob(container, {
    projectId,
    userId,
    jobType: COMPETITOR_RESEARCH_JOB_TYPE,
    params: { mode: 'discover', domain },
  });
  return { jobId: job.id, status: job.status, mode: 'discover', domain, reused: false, snapshotId: null };
}

/**
 * Start one keyword-gap analysis for up to the platform maximum of competitors.
 * Domains are normalized, de-duplicated and never allowed to include the target
 * itself; the run cap is enforced here so an over-eager caller cannot multiply
 * provider cost. A fresh snapshot for the same competitor set is reused.
 */
export async function startCompetitorGap(
  container: ServiceContainer,
  projectId: string,
  userId: string,
  rawDomain: string | undefined,
  competitors: string[],
  opts: CompetitorStartOptions = {},
): Promise<CompetitorGapStartDto> {
  const domain = await resolveProjectDomain(container, projectId, rawDomain);
  const normalized = normalizeCompetitors(domain, competitors);
  const scope = competitorGapScope({ domain, competitors: normalized });
  if (!opts.refresh) {
    const reused = await freshSnapshot(container, projectId, 'competitor_gap', scope);
    if (reused) {
      return { jobId: null, status: 'completed', mode: 'gap', domain, competitors: normalized, reused: true, snapshotId: reused.id };
    }
  }
  const job = await enqueueJob(container, {
    projectId,
    userId,
    jobType: COMPETITOR_RESEARCH_JOB_TYPE,
    params: { mode: 'gap', domain, competitors: normalized },
  });
  return { jobId: job.id, status: job.status, mode: 'gap', domain, competitors: normalized, reused: false, snapshotId: null };
}

/**
 * Read the current discovery snapshot for the project (or an explicit domain
 * override), or null when none has ever been written. Reads never call the
 * provider, so opening the view can never incur cost.
 */
export async function readCurrentCompetitorDiscovery(
  container: ServiceContainer,
  projectId: string,
  rawDomain?: string,
): Promise<SourceSnapshotDto | null> {
  const domain = await resolveProjectDomain(container, projectId, rawDomain);
  const scope = competitorDiscoveryScope({ domain });
  const record = await readSourceSnapshot(container, projectId, 'competitor_discovery', scope);
  return record ? toSourceSnapshotDto(record) : null;
}

/**
 * Read the current gap snapshot for the given competitor set, or null when none
 * exists. Uses the same normalization/validation as the start path.
 */
export async function readCurrentCompetitorGap(
  container: ServiceContainer,
  projectId: string,
  rawDomain: string | undefined,
  competitors: string[],
): Promise<SourceSnapshotDto | null> {
  const domain = await resolveProjectDomain(container, projectId, rawDomain);
  const normalized = normalizeCompetitors(domain, competitors);
  const scope = competitorGapScope({ domain, competitors: normalized });
  const record = await readSourceSnapshot(container, projectId, 'competitor_gap', scope);
  return record ? toSourceSnapshotDto(record) : null;
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

/** Project the bounded competitor candidates stored on a completed run. */
function candidatesFromResult(job: JobRecord): CompetitorCandidateDto[] {
  return projectCandidateRows(job.result?.competitors);
}

/** Project the bounded gap rows stored on a completed run. */
function gapsFromResult(job: JobRecord): CompetitorGapDto[] {
  return projectGapRows(job.result?.gaps);
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
