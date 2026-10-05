/**
 * Resource admission service (P9).
 *
 * One obvious place asks "may this account consume this resource?". Enforcement
 * itself is atomic and lives in the database (`seo_admit_job` BEFORE INSERT
 * trigger on seo_sync_jobs, see supabase/migrations/20260101000039_*), so no
 * enqueue path can bypass it and concurrent requests cannot oversubscribe the
 * queue. This service is the application-side half:
 *
 *   - classify a job type into the closed resource vocabulary;
 *   - recognise a database admission denial;
 *   - map it onto a stable, secret-free API error;
 *   - record best-effort denial evidence for operational visibility.
 *
 * It is deliberately not a quota/pricing system: there are no plans, tiers,
 * credits or per-feature entitlements. See docs/p9-resource-protection.md.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isValidResourceScope,
  type ResourceErrorCode,
  type ResourceErrorDetails,
  type ResourceKind,
  type ResourceScope,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';

/**
 * Job type -> coarse protected resource. Unknown types fall back to the generic
 * `background_job` so a newly added job type is still admitted (and attributed)
 * rather than silently exempt. Kept next to the executor registry conceptually:
 * a new job type should get an entry here when it consumes a distinct resource.
 */
const JOB_RESOURCE: Record<string, ResourceKind> = {
  gsc_sync: 'google_search_console',
  analytics_sync: 'google_analytics',
  dataforseo_rank_sync: 'dataforseo_serp',
  dataforseo_keyword_research: 'dataforseo_keywords',
  serp_retrieval: 'dataforseo_serp',
  competitor_research: 'dataforseo_research',
  website_crawl: 'background_job',
  website_audit: 'background_job',
  knowledge_index: 'background_job',
  knowledge_reindex: 'background_job',
  knowledge_delete: 'background_job',
  knowledge_discovery: 'background_job',
  knowledge_source_ingest: 'background_job',
  knowledge_source_refresh: 'background_job',
  knowledge_source_delete: 'background_job',
  content_generate: 'ai_generation',
  content_write: 'ai_generation',
  content_analyze: 'ai_generation',
  content_images: 'ai_image',
  agent_design: 'ai_generation',
  publish: 'publishing',
  publish_update: 'publishing',
  publish_delete: 'publishing',
};

/** Classify a platform job type into the closed resource vocabulary. */
export function resourceForJobType(jobType: string): ResourceKind {
  return JOB_RESOURCE[jobType] ?? 'background_job';
}

/** Human-readable, actionable explanations (never leak counts or limits). */
const RESOURCE_ERROR_MESSAGES: Record<ResourceErrorCode, string> = {
  queue_limit:
    'This account or project already has too many jobs queued. Wait for some to finish, then try again.',
  resource_concurrency:
    'This account or project already has too many operations running. Wait for some to finish, then try again.',
  resource_limit: 'Too many requests in a short time. Wait a moment, then try again.',
};

/** SQLSTATEs raised by seo_admit_job, mapped to the stable public codes. */
const SQLSTATE_TO_CODE: Record<string, ResourceErrorCode> = {
  SE001: 'queue_limit',
  SE002: 'resource_concurrency',
  SE003: 'resource_limit',
};

/** Message prefixes raised by seo_admit_job, used when the SQLSTATE is not surfaced. */
const MESSAGE_TO_CODE: ReadonlyArray<[string, ResourceErrorCode]> = [
  ['seo_queue_limit', 'queue_limit'],
  ['seo_resource_concurrency', 'resource_concurrency'],
  ['seo_resource_rate', 'resource_limit'],
];

/** A recognised admission denial before it becomes an API error. */
export interface AdmissionFailure {
  code: ResourceErrorCode;
  scope: ResourceScope;
}

export interface RecordDenialArgs {
  projectId: string;
  userId: string | null;
  resource: ResourceKind;
  code: ResourceErrorCode;
  scope: ResourceScope;
  jobType?: string | null;
  requested?: number;
}

/** A synchronous operation asking to be admitted against a protected resource. */
export interface SyncAdmissionRequest {
  projectId: string;
  userId: string | null;
  resource: ResourceKind;
  amount?: number;
  /** Safety TTL for a leaked reservation; defaults to 15 minutes. */
  ttlSeconds?: number;
}

export class ResourceAdmissionService {
  constructor(private readonly sb: SupabaseClient) {}

  /** The closed resource a given job type consumes. */
  classify(jobType: string): ResourceKind {
    return resourceForJobType(jobType);
  }

  /**
   * Recognise a database admission denial. Returns null for any other error so
   * callers can rethrow unrelated failures unchanged. Detection uses the custom
   * SQLSTATE first (works on both the direct-pg and PostgREST stores) and falls
   * back to the raised message.
   */
  admissionErrorFrom(err: unknown): AdmissionFailure | null {
    const rec = (err ?? {}) as { code?: unknown; message?: unknown; detail?: unknown; details?: unknown };
    const sqlstate = typeof rec.code === 'string' ? rec.code : '';
    const message = err instanceof Error ? err.message : typeof rec.message === 'string' ? rec.message : '';
    let code: ResourceErrorCode | null = SQLSTATE_TO_CODE[sqlstate] ?? null;
    if (!code) {
      for (const [needle, candidate] of MESSAGE_TO_CODE) {
        if (message.includes(needle)) {
          code = candidate;
          break;
        }
      }
    }
    if (!code) return null;
    return { code, scope: this.parseScope(rec) };
  }

  /** Build the stable, secret-free API error for a denial. */
  toApiError(failure: AdmissionFailure, jobType: string): ApiError {
    return this.toApiErrorForResource(failure, resourceForJobType(jobType));
  }

  /** Build the stable, secret-free API error for a denial of a named resource. */
  toApiErrorForResource(failure: AdmissionFailure, resource: ResourceKind): ApiError {
    const details: ResourceErrorDetails = { resource, scope: failure.scope };
    return ApiError.resourceLimited(failure.code, RESOURCE_ERROR_MESSAGES[failure.code], details);
  }

  // -------------------------------------------------------------------------
  // Synchronous admission (P11)
  // -------------------------------------------------------------------------

  /**
   * Admit (and reserve) one synchronous operation. The database evaluates the
   * technical ceilings atomically (advisory locks) and inserts the reservation;
   * a denial is mapped onto the same structured 429 as the async job path.
   * Returns the reservation id, which the caller must release when done.
   */
  async admit(request: SyncAdmissionRequest): Promise<string> {
    const { data, error } = await this.sb.rpc('seo_admit_resource', {
      p_project_id: request.projectId,
      p_resource: request.resource,
      p_amount: request.amount ?? 1,
      p_ttl_seconds: request.ttlSeconds ?? 900,
    });
    if (error) {
      const failure = this.admissionErrorFrom(error);
      if (failure) {
        await this.recordDenial({
          projectId: request.projectId,
          userId: request.userId,
          resource: request.resource,
          code: failure.code,
          scope: failure.scope,
          jobType: null,
          requested: request.amount ?? 1,
        });
        throw this.toApiErrorForResource(failure, request.resource);
      }
      logger.error({ error, resource: request.resource }, 'sync resource admission failed');
      throw new ApiError(500, 'resource_admission_failed', 'Could not evaluate resource availability.');
    }
    return String(data);
  }

  /** Release a reservation once the operation has finished. Best-effort. */
  async release(reservationId: string | null | undefined): Promise<void> {
    if (!reservationId) return;
    try {
      const { error } = await this.sb.rpc('seo_release_resource', { p_reservation_id: reservationId });
      if (error) logger.warn({ error }, 'resource reservation release failed');
    } catch (err) {
      logger.warn({ err }, 'resource reservation release failed');
    }
  }

  /**
   * Run `fn` under a synchronous resource reservation, releasing it afterwards
   * whether `fn` succeeds or throws. A resource denial from `admit` propagates
   * unchanged so callers stop before doing any provider work.
   */
  async withAdmission<T>(request: SyncAdmissionRequest, fn: () => Promise<T>): Promise<T> {
    const reservationId = await this.admit(request);
    try {
      return await fn();
    } finally {
      await this.release(reservationId);
    }
  }

  /**
   * Record denial evidence for operational visibility. Best-effort and
   * deliberately outside the transaction boundary: the trigger's exception has
   * already rolled the failed insert back, and a logging failure must never
   * turn a clear resource error into an internal error.
   */
  async recordDenial(args: RecordDenialArgs): Promise<void> {
    try {
      const accountId = await this.accountForProject(args.projectId);
      const { error } = await this.sb.from('seo_resource_denials').insert({
        account_id: accountId,
        project_id: args.projectId,
        user_id: args.userId,
        resource: args.resource,
        code: args.code,
        scope: args.scope,
        requested: args.requested ?? 1,
        job_type: args.jobType ?? null,
      } as never);
      if (error) logger.warn({ error, code: args.code }, 'resource denial not recorded');
    } catch (err) {
      logger.error({ err, code: args.code }, 'resource denial record failed');
    }
  }

  private async accountForProject(projectId: string): Promise<string | null> {
    const { data } = await this.sb
      .from('seo_projects')
      .select('account_id')
      .eq('id', projectId)
      .maybeSingle<{ account_id: string | null }>();
    return data?.account_id ?? null;
  }

  private parseScope(rec: { detail?: unknown; details?: unknown }): ResourceScope {
    const raw = rec.details ?? rec.detail;
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    const scope = (parsed as { scope?: unknown } | null)?.scope;
    return isValidResourceScope(scope) ? scope : 'project';
  }
}
