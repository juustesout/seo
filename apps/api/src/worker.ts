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

import { getContainer } from './context.js';
import { logger } from './logger.js';
import { SeoWriter } from './persistence/seoWriter.js';
import { getExecutor } from './jobs/executors.js';
import { jobErrorPayload } from './jobs/types.js';
import type { JobRecord } from './jobs/types.js';

const IDLE_POLL_MS = 5_000;
const STALE_RUNNING_MS = 25 * 60 * 1000;

let stopping = false;

async function sweepStaleRunning(): Promise<void> {
  const { sb } = getContainer();
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const { data, error } = await sb
    .from('seo_sync_jobs')
    .update({ status: 'queued', started_at: null })
    .eq('status', 'running')
    .lte('started_at', cutoff)
    .select('id');
  if (error) {
    logger.error({ error }, 'stale job sweep failed');
    return;
  }
  if (data && data.length > 0) logger.info({ ids: data.map((d) => d.id) }, 'requeued stale running jobs');
}

async function runOnce(container: ReturnType<typeof getContainer>): Promise<boolean> {
  const job: JobRecord | null = await container.jobStore.claimNext();
  if (!job) return false;

  const writer = new SeoWriter(container.sb);
  const executor = getExecutor(job.job_type);
  const log = logger.child({ jobId: job.id, jobType: job.job_type, projectId: job.project_id });

  if (!executor) {
    const { error, retryable } = jobErrorPayload(
      new Error(`Job type '${job.job_type}' has no executor registered`),
      { provider: job.provider, operation: job.job_type, project_id: job.project_id, job_type: job.job_type },
    );
    error.code = 'unsupported_job_type';
    await container.jobStore.fail(job.id, error, false);
    log.warn('unsupported job type failed permanently');
    return true;
  }

  log.info('job started');
  try {
    const result = await executor({
      container,
      job,
      writer,
      report: async (progress, message) => {
        await container.jobStore.updateProgress(job.id, Math.max(0, Math.min(100, progress)), message ?? null);
      },
    });
    await container.jobStore.complete(job.id, result ?? {});
    log.info({ result }, 'job completed');
  } catch (err) {
    const { error, retryable } = jobErrorPayload(err, {
      provider: job.provider,
      operation: job.job_type,
      project_id: job.project_id,
      job_type: job.job_type,
    });
    log.error({ err, retryable }, 'job failed');
    await container.jobStore.fail(job.id, error, retryable);
  }
  return true;
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
  await sweepStaleRunning();
  const sweepTimer = setInterval(() => void sweepStaleRunning(), STALE_RUNNING_MS);

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

if (import.meta.url === `file://${process.argv[1]}`) {
  void runWorker().catch((err) => {
    logger.fatal({ err }, 'worker crashed');
    process.exit(1);
  });
}
