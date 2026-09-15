/**
 * GSC sync application service (initial sync + manual Sync).
 *
 * The sync itself already exists as the `gsc_sync` job + executor; this service
 * only decides *when* one is enqueued and how duplicate requests collapse. A
 * project-scoped sync needs both a linked property and a project data source,
 * which is exactly what a successful property attach produces - so the explicit
 * Sync button and both attach endpoints funnel here.
 *
 * It never calls Google, never invents progress and never depends on a new job
 * type or scheduler: the executor reports real phase progress through the same
 * seo_sync_jobs row the UI already polls. Idempotency is expressed with the
 * existing idempotency_key uniqueness, so a read-then-insert race still yields
 * exactly one active sync for the project.
 */

import type { JobRecord } from '../jobs/types.js';
import type { ServiceContainer } from '../context.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { logger } from '../logger.js';

export const GSC_SYNC_JOB_TYPE = 'gsc_sync';

/** Job states that mean a sync is already in flight and must be reused. */
const ACTIVE_JOB_STATUSES = ['queued', 'running'] as const;

export interface GscSyncEnqueueResult {
  job: JobRecord;
  /** True when a queued/running sync was reused instead of a new one created. */
  reused: boolean;
}

export interface GscSyncRequest {
  projectId: string;
  userId: string;
  params?: Record<string, unknown>;
}

/** The project's queued/running gsc_sync (newest first), if any. */
async function activeGscSync(container: ServiceContainer, projectId: string): Promise<JobRecord | null> {
  const { data } = await container.sb
    .from('seo_sync_jobs')
    .select('*')
    .eq('project_id', projectId)
    .eq('job_type', GSC_SYNC_JOB_TYPE)
    .in('status', [...ACTIVE_JOB_STATUSES])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as JobRecord | null) ?? null;
}

/**
 * The id of the project's most recent sync job, whatever its state, or null when
 * none exists. Two concurrent triggers read the same predecessor and therefore
 * derive the same idempotency key, so only one insert survives - the loser's
 * duplicate-key conflict is resolved back to the winner's active job. A later
 * trigger reads the finished job as its predecessor and gets a fresh key, so the
 * explicit Sync button can always start another run.
 */
async function lastGscSyncId(container: ServiceContainer, projectId: string): Promise<string | null> {
  const { data } = await container.sb
    .from('seo_sync_jobs')
    .select('id')
    .eq('project_id', projectId)
    .eq('job_type', GSC_SYNC_JOB_TYPE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * Enqueue one gsc_sync unless an equivalent sync is already queued/running for
 * the project, in which case that job is reused. Never creates a second
 * concurrent sync for the same project. Throws (via the shared enqueue gate)
 * when the provider is absent/not connected, so the explicit Sync button can
 * surface an honest error; callers that must not fail use tryEnqueueGscSync.
 */
export async function enqueueGscSyncIfIdle(
  container: ServiceContainer,
  request: GscSyncRequest,
): Promise<GscSyncEnqueueResult> {
  const existing = await activeGscSync(container, request.projectId);
  if (existing) return { job: existing, reused: true };

  const predecessor = await lastGscSyncId(container, request.projectId);
  const idempotencyKey = `${GSC_SYNC_JOB_TYPE}:${request.projectId}:${predecessor ?? 'initial'}`;

  try {
    const job = await enqueueJob(container, {
      projectId: request.projectId,
      userId: request.userId,
      jobType: GSC_SYNC_JOB_TYPE,
      params: request.params ?? {},
      idempotencyKey,
    });
    return { job, reused: false };
  } catch (err) {
    // A concurrent trigger inserted between our pre-check and our insert and
    // won the idempotency key. Reuse its active job instead of failing.
    const winner = await activeGscSync(container, request.projectId);
    if (winner) return { job: winner, reused: true };
    throw err;
  }
}

/**
 * Best-effort variant for the attach flow: a sync that cannot be queued must
 * never fail the property attachment itself. The failure is logged and the user
 * can retry through the explicit Sync button.
 */
export async function tryEnqueueGscSync(
  container: ServiceContainer,
  request: GscSyncRequest,
): Promise<GscSyncEnqueueResult | null> {
  try {
    return await enqueueGscSyncIfIdle(container, request);
  } catch (err) {
    logger.warn(
      { err, projectId: request.projectId },
      'initial gsc sync enqueue failed; property attach is unaffected',
    );
    return null;
  }
}
