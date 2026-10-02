/**
 * Background job worker.
 *
 * Claims queued jobs (atomic via SKIP LOCKED on Postgres, compare-and-swap on
 * PostgREST), dispatches to executors and records terminal state with retry /
 * backoff semantics. Long-running operations never block HTTP requests because
 * they run here or on a scaled-out fleet of this same process.
 *
 * The mechanism (this loop) is intentionally swappable - the domain only
 * depends on the JobStore interface and job types.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getContainer } from './context.js';
import { logger } from './logger.js';
import { SeoWriter } from './persistence/seoWriter.js';
import { getExecutor } from './jobs/executors.js';
import { jobErrorPayload } from './jobs/types.js';
import type { JobRecord } from './jobs/types.js';
import { RetryBudget, runWithRetryBudget } from './reliability/retry.js';
import { syncScheduleStatus } from './services/scheduleService.js';
import { AgentRunService } from './services/agentRunService.js';
import { appendUsage, jobUsageEvent } from './services/usageInstrumentation.js';

const IDLE_POLL_MS = 5_000;
const STALE_RUNNING_MS = 25 * 60 * 1000;
/** Minimum spacing between orphaned-run reconciliation sweeps on the idle path. */
const AGENT_RUN_RECONCILE_INTERVAL_MS = 60 * 1000;

let stopping = false;
let lastAgentRunReconcileAt = 0;

export async function sweepStaleRunning(
  container: ReturnType<typeof getContainer>,
): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const { data, error } = await container.sb
    .from('seo_sync_jobs')
    .select('id, provider, job_type, retry_count, max_retries')
    .eq('status', 'running')
    .lte('started_at', cutoff);
  if (error) {
    logger.error({ error }, 'stale job sweep failed');
    return;
  }
  if (!data || data.length === 0) return;
  const requeued: string[] = [];
  const failed: string[] = [];
  for (const row of data as Array<{
    id: string;
    provider: string | null;
    job_type: string;
    retry_count: number | null;
    max_retries: number | null;
  }>) {
    // Reuse the job store's failure path so a worker crash counts as an attempt:
    // it requeues with backoff while retries remain and terminally fails with a
    // stale_worker error once max_retries is exceeded. Without this a job that
    // repeatedly kills the worker would be requeued forever.
    const stale = Object.assign(new Error('Job was still running when the worker stopped'), {
      code: 'stale_worker',
    });
    const { error: payload, retryable } = jobErrorPayload(stale, {
      provider: row.provider ?? undefined,
      operation: row.job_type,
      project_id: '',
      job_type: row.job_type,
    });
    try {
      await container.jobStore.fail(row.id, payload, retryable);
      const willRetry = retryable && (row.retry_count ?? 0) + 1 <= (row.max_retries ?? 3);
      (willRetry ? requeued : failed).push(row.id);
    } catch (err) {
      logger.error({ err, id: row.id }, 'stale job recovery failed');
    }
  }
  if (requeued.length > 0) logger.info({ ids: requeued }, 'requeued stale running jobs');
  if (failed.length > 0) logger.warn({ ids: failed }, 'failed stale running jobs past retry budget');
}

/**
 * Adopt durable agent runs whose submission was interrupted before their job
 * was recorded. Reuses the existing idle loop rather than a second scheduler;
 * the throttle keeps the sweep off the queue hot path while still recovering
 * orphans within a minute. Reconciling is best-effort and must never take the
 * worker down, so failures are logged and swallowed.
 */
async function reconcileAgentRuns(
  container: ReturnType<typeof getContainer>,
  force = false,
): Promise<void> {
  if (!force && Date.now() - lastAgentRunReconcileAt < AGENT_RUN_RECONCILE_INTERVAL_MS) return;
  lastAgentRunReconcileAt = Date.now();
  try {
    const result = await new AgentRunService(container).reconcileOrphanedRuns();
    if (result.reconciled > 0) logger.info(result, 'reconciled orphaned agent runs');
  } catch (err) {
    logger.error({ err }, 'agent run reconciliation sweep failed');
  }
}


export async function runOnce(container: ReturnType<typeof getContainer>): Promise<boolean> {
  const job: JobRecord | null = await container.jobStore.claimNext();
  if (!job) return false;

  const writer = new SeoWriter(container.sb);
  const executor = getExecutor(job.job_type);
  const log = logger.child({ jobId: job.id, jobType: job.job_type, projectId: job.project_id });
  const startedAtMs = job.started_at ? Date.parse(job.started_at) : null;
  const durationMs = startedAtMs === null || Number.isNaN(startedAtMs) ? null : Date.now() - startedAtMs;

  // Schedules are planning rows; reflect execution on the read model. The
  // sync is best-effort and scoped to publish jobs that carry a schedule_id.
  const scheduleId = typeof job.params?.schedule_id === 'string' ? job.params.schedule_id : null;
  if (scheduleId && PUBLISH_JOB_TYPES.has(job.job_type)) {
    await syncScheduleStatus(container, { projectId: job.project_id, scheduleId, status: 'publishing' });
  }

  if (!executor) {
    const { error } = jobErrorPayload(
      new Error(`Job type '${job.job_type}' has no executor registered`),
      { provider: job.provider, operation: job.job_type, project_id: job.project_id, job_type: job.job_type },
    );
    error.code = 'unsupported_job_type';
    // A missing executor means this worker predates the job type - for example a
    // worker still running the previous release during a deploy race - not that
    // the job is invalid. Requeue it with backoff so a current worker can run it
    // rather than permanently failing an otherwise valid job.
    await container.jobStore.fail(job.id, error, true);
    log.warn('unknown job type; requeued for another worker');
    return true;
  }

  log.info('job started');
  try {
    // One budget per logical job execution, shared by every nested provider
    // retry, bounds total outbound retries regardless of how many calls the
    // executor makes.
    const result = await runWithRetryBudget(
      new RetryBudget(container.config.retry.perJobBudget),
      () =>
        executor({
          container,
          job,
          writer,
          report: async (progress, message) => {
            await container.jobStore.updateProgress(job.id, Math.max(0, Math.min(100, progress)), message ?? null);
          },
        }),
    );
    await container.jobStore.complete(job.id, result ?? {});
    log.info({ result }, 'job completed');
    await recordJobUsage(container, job, true, 'completed', durationMs);
    if (scheduleId && PUBLISH_JOB_TYPES.has(job.job_type)) {
      await syncScheduleStatus(container, { projectId: job.project_id, scheduleId, status: 'published' });
    }
  } catch (err) {
    const { error, retryable } = jobErrorPayload(err, {
      provider: job.provider,
      operation: job.job_type,
      project_id: job.project_id,
      job_type: job.job_type,
    });
    // An executor may attach a bounded, non-secret summary of what it managed to
    // do before failing; persist it on terminal failure so the UI can explain.
    const failureResult =
      err && typeof err === 'object' ? (err as { jobResult?: Record<string, unknown> }).jobResult : undefined;
    log.error({ err, retryable }, 'job failed');
    await container.jobStore.fail(job.id, error, retryable, failureResult);
    await flagFailedPublication(container, job, error.message, retryable);
    // Retryable means the job store requeued it with backoff -> the job is not
    // terminal, so it has no usage fact yet. Only a terminal failure records one.
    const willRetry = retryable && job.retry_count + 1 <= job.max_retries;
    if (!willRetry) {
      await recordJobUsage(container, job, false, 'failed', durationMs);
    }
    if (scheduleId && PUBLISH_JOB_TYPES.has(job.job_type)) {
      await syncScheduleStatus(container, {
        projectId: job.project_id,
        scheduleId,
        status: willRetry ? 'queued' : 'failed',
      });
    }
  }
  return true;
}

/**
 * Record the single, terminal usage fact for a job execution (R5.10.4). At most
 * one event per job is ever written (`sourceId = job.id`), so worker retries of
 * the same logical job do not multiply it. Best-effort: a ledger failure must
 * never affect the job outcome.
 */
async function recordJobUsage(
  container: ReturnType<typeof getContainer>,
  job: JobRecord,
  success: boolean,
  status: 'completed' | 'failed',
  durationMs: number | null,
): Promise<void> {
  const event = jobUsageEvent({ job, success, status, durationMs });
  if (event) await appendUsage(container.usageEvents, [event]);
}

const PUBLISH_JOB_TYPES = new Set(['publish', 'publish_update', 'publish_delete']);

/** Keep seo_publications state honest when a publish job fails. */
async function flagFailedPublication(
  container: ReturnType<typeof getContainer>,
  job: JobRecord,
  message: string,
  retryable: boolean,
): Promise<void> {
  if (!PUBLISH_JOB_TYPES.has(job.job_type)) return;
  const publicationId = job.params?.publication_id;
  if (typeof publicationId !== 'string') return;
  const status = retryable ? 'queued' : 'failed';
  await container.sb
    .from('seo_publications')
    .update({ status, error: message.slice(0, 500) })
    .eq('project_id', job.project_id)
    .eq('id', publicationId);
}

function waitForWork(container: ReturnType<typeof getContainer>): Promise<void> {
  const store = container.jobStore as { events?: import('node:events').EventEmitter };
  const events = store.events;
  if (events) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        events.removeAllListeners();
        resolve();
      }, IDLE_POLL_MS);
      events.once('job', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  return new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
}

export async function runWorker(): Promise<void> {
  const container = getContainer();
  logger.info('SEO job worker started');
  await sweepStaleRunning(container);
  await reconcileAgentRuns(container, true);
  const sweepTimer = setInterval(() => void sweepStaleRunning(container), STALE_RUNNING_MS);

  process.on('SIGTERM', () => {
    stopping = true;
    logger.info('worker shutting down');
  });
  process.on('SIGINT', () => {
    stopping = true;
    logger.info('worker shutting down');
  });

  while (!stopping) {
    try {
      const didWork = await runOnce(container);
      if (!didWork) {
        await reconcileAgentRuns(container);
        await waitForWork(container);
      }
    } catch (err) {
      logger.error({ err }, 'worker loop error');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  clearInterval(sweepTimer);
  await container.pgPool?.end().catch(() => undefined);
}

/**
 * Only run when this module is the process entrypoint. Deploys run node
 * against a `current` symlink, so process.argv[1] keeps the symlink path while
 * import.meta.url is the realpath Node resolved; compare realpaths so the
 * worker still starts under the release symlink layout.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void runWorker().catch((err) => {
    logger.fatal({ err }, 'worker crashed');
    process.exit(1);
  });
}
