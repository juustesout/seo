/**
 * GA4 page-traffic sync application service (P7 measurement loop).
 *
 * The sync itself is the `analytics_sync` job + executor; this service only
 * decides when to enqueue one and collapses duplicate requests. Like the GSC
 * sync service it never calls Google and never invents progress: the executor
 * writes real rows through the shared SeoWriter and the job row the UI polls is
 * the same seo_sync_jobs table every other provider uses.
 */

import type { JobRecord } from '../jobs/types.js';
import type { ServiceContainer } from '../context.js';
import { enqueueJob } from '../jobs/enqueue.js';

export const ANALYTICS_SYNC_JOB_TYPE = 'analytics_sync';

/** Job states that mean a sync is already in flight and must be reused. */
const ACTIVE_JOB_STATUSES = ['queued', 'running'] as const;

export interface AnalyticsSyncEnqueueResult {
  job: JobRecord;
  /** True when a queued/running sync was reused instead of a new one created. */
  reused: boolean;
}

export interface AnalyticsSyncRequest {
  projectId: string;
  userId: string;
  params?: Record<string, unknown>;
}

async function activeAnalyticsSync(container: ServiceContainer, projectId: string): Promise<JobRecord | null> {
  const { data } = await container.sb
    .from('seo_sync_jobs')
    .select('*')
    .eq('project_id', projectId)
    .eq('job_type', ANALYTICS_SYNC_JOB_TYPE)
    .in('status', [...ACTIVE_JOB_STATUSES])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as JobRecord | null) ?? null;
}

async function lastAnalyticsSyncId(container: ServiceContainer, projectId: string): Promise<string | null> {
  const { data } = await container.sb
    .from('seo_sync_jobs')
    .select('id')
    .eq('project_id', projectId)
    .eq('job_type', ANALYTICS_SYNC_JOB_TYPE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * Enqueue one analytics_sync unless an equivalent sync is already queued/running
 * for the project, in which case that job is reused. Throws (via the shared
 * enqueue gate) when the account has no connected GA4 integration, so the
 * explicit Sync button can surface an honest error.
 */
export async function enqueueAnalyticsSyncIfIdle(
  container: ServiceContainer,
  request: AnalyticsSyncRequest,
): Promise<AnalyticsSyncEnqueueResult> {
  const existing = await activeAnalyticsSync(container, request.projectId);
  if (existing) return { job: existing, reused: true };

  const predecessor = await lastAnalyticsSyncId(container, request.projectId);
  const idempotencyKey = `${ANALYTICS_SYNC_JOB_TYPE}:${request.projectId}:${predecessor ?? 'initial'}`;

  try {
    const job = await enqueueJob(container, {
      projectId: request.projectId,
      userId: request.userId,
      jobType: ANALYTICS_SYNC_JOB_TYPE,
      params: request.params ?? {},
      idempotencyKey,
    });
    return { job, reused: false };
  } catch (err) {
    const winner = await activeAnalyticsSync(container, request.projectId);
    if (winner) return { job: winner, reused: true };
    throw err;
  }
}
