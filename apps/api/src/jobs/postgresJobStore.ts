/**
 * JobStore backed by direct Postgres (when SUPABASE_DB_URL is set).
 *
 * claimNext is a single atomic statement: an UPDATE whose subquery picks the
 * oldest runnable row FOR UPDATE SKIP LOCKED. SKIP LOCKED means a claimant
 * skips rows another transaction has locked instead of waiting or double-
 * claiming, so any number of worker processes can safely share one queue.
 *
 * Wake-ups: a Postgres trigger pg_notify()s seo_jobs_channel whenever a job
 * transitions into the runnable 'queued' state (INSERT queued, or UPDATE into
 * queued). This store holds one dedicated LISTEN connection (never a pooled
 * client, which could be recycled and silently drop notifications) and fans
 * notifications out through `events`, so an idle worker wakes instantly instead
 * of polling. Failures re-queue with exponential backoff via retryDelayMs and
 * retry_count/max_retries bookkeeping that stays honest across retries.
 */

import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { ApiError } from '../apiErrors.js';
import { retryDelayMs, type EnqueueJobInput, type JobRecord, type JobStore } from './types.js';
import { logger } from '../logger.js';

/**
 * Column projection shared by every SELECT and RETURNING. queued_at is rendered
 * to a UTC ISO-8601 string with millisecond precision in SQL because the other
 * timestamp columns arrive from node-postgres as JS Date objects and are
 * normalized in mapRow - formatting queued_at in SQL keeps both backends
 * (this one and the PostgREST store) producing byte-identical strings.
 */
const JOB_COLUMNS = `id, project_id, integration_id, data_source_id, provider, job_type,
  status, params, progress, message, result, error,
  to_char(queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS queued_at,
  started_at, completed_at, run_after, retry_count, max_retries, created_by`;

/**
 * Normalize a raw pg row onto the shared JobRecord shape: stringify JS Date
 * timestamps to ISO, null-coalesce the JSON columns, and fill in the defaults
 * the schema would otherwise apply (progress 0, max_retries 3, empty params).
 * Keeping one mapper here means callers never touch pg-specific types.
 */
function mapRow(row: Record<string, unknown> | undefined | null): JobRecord | null {
  if (!row) return null;
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    integration_id: (row.integration_id as string | null) ?? null,
    data_source_id: (row.data_source_id as string | null) ?? null,
    provider: row.provider as string,
    job_type: row.job_type as string,
    status: row.status as JobRecord['status'],
    params: (row.params as Record<string, unknown>) ?? {},
    progress: (row.progress as number) ?? 0,
    message: (row.message as string | null) ?? null,
    result: (row.result as Record<string, unknown> | null) ?? null,
    error: row.error as JobRecord['error'],
    queued_at: (row.queued_at as string) ?? new Date().toISOString(),
    started_at: row.started_at ? new Date(row.started_at as string).toISOString() : null,
    completed_at: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
    run_after: row.run_after ? new Date(row.run_after as string).toISOString() : new Date().toISOString(),
    retry_count: (row.retry_count as number) ?? 0,
    max_retries: (row.max_retries as number) ?? 3,
    created_by: (row.created_by as string | null) ?? null,
  };
}

/**
 * Direct-Postgres JobStore - the strongest of the two implementations. Claims
 * are atomic (single UPDATE ... FOR UPDATE SKIP LOCKED) so many concurrent
 * workers can race safely, and a LISTEN connection makes wake-ups near-
 * instantaneous. Selected when SUPABASE_DB_URL is configured; otherwise the
 * process falls back to SupabaseJobStore (compare-and-swap).
 */
export class PostgresJobStore implements JobStore {
  /**
   * Wake-up bus consumed by the worker. The LISTEN connection (see constructor)
   * forwards each seo_jobs_channel notification here as a 'job' event so an
   * idle worker can stop polling and react immediately.
   */
  readonly events = new EventEmitter();

  /**
   * Open one long-lived connection that LISTENs on seo_jobs_channel. It must be
   * its own connection rather than a pool client: pool.query() hands each call
   * to whichever client is free, and a LISTEN registered on a returned client
   * would be silently lost, so notifications would never arrive. The 'error'
   * handler prevents a socket-level failure on this background connection from
   * crashing the process.
   */
  constructor(private readonly pool: Pool) {
    this.pool.connect().then((client) => {
      client.on('error', (err) => logger.error({ err }, 'pg notify client error'));
      client.query('LISTEN seo_jobs_channel').catch((err) => logger.error({ err }, 'LISTEN failed'));
      client.on('notification', () => {
        this.events.emit('job');
      });
    });
  }

  /**
   * Insert one durable job row. run_after (default: now) is the earliest moment
   * the job may be claimed - future run_after values are how scheduled/deferred
   * work is expressed. Re-submitting the same logical work is prevented by the
   * schema's unique index on idempotency_key, which turns the duplicate insert
   * into a constraint violation rather than a second row.
   */
  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const result = await this.pool.query(
      `insert into seo_sync_jobs
        (project_id, integration_id, data_source_id, provider, job_type, params,
         created_by, run_after, max_retries, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       returning ${JOB_COLUMNS}`,
      [
        input.project_id,
        input.integration_id ?? null,
        input.data_source_id ?? null,
        input.provider,
        input.job_type,
        JSON.stringify(input.params ?? {}),
        input.created_by ?? null,
        input.run_after ?? new Date().toISOString(),
        input.max_retries ?? 3,
        input.idempotency_key ?? null,
      ],
    );
    return mapRow(result.rows[0])!;
  }

  /** Fetch one job by id, or null when it does not exist. */
  async get(id: string): Promise<JobRecord | null> {
    const result = await this.pool.query(`select ${JOB_COLUMNS} from seo_sync_jobs where id = $1`, [id]);
    return mapRow(result.rows[0]);
  }

  /** Most recent jobs for a project, newest first (limit clamped to 200) - the jobs UI/API read path. */
  async list(projectId: string, limit = 50): Promise<JobRecord[]> {
    const result = await this.pool.query(
      `select ${JOB_COLUMNS} from seo_sync_jobs
        where project_id = $1
        order by created_at desc
        limit $2`,
      [projectId, Math.max(1, Math.min(200, limit))],
    );
    return (result.rows as Record<string, unknown>[]).map((row) => mapRow(row)!);
  }

  /**
   * Atomically claim the oldest runnable job and flip it to 'running'.
   * The subquery selects the single oldest eligible row (queued and past its
   * run_after) FOR UPDATE SKIP LOCKED: concurrent claimants block on nothing
   * and skip rows already locked by a peer, so exactly one worker ever wins a
   * given row. The outer UPDATE then marks it running with started_at set and
   * returns the full row; null means nothing was runnable.
   */
  async claimNext(): Promise<JobRecord | null> {
    const result = await this.pool.query(
      `update seo_sync_jobs j
         set status = 'running', started_at = now()
       where j.id = (
         select id from seo_sync_jobs
         where status = 'queued' and run_after <= now()
         order by queued_at asc
         limit 1
         for update skip locked
       )
       returning ${JOB_COLUMNS}`,
    );
    return mapRow(result.rows[0]);
  }

  /** Persist 0-100 progress plus an optional human-readable message (live job feed). */
  async updateProgress(id: string, progress: number, message?: string | null): Promise<void> {
    await this.pool.query('update seo_sync_jobs set progress=$2, message=$3 where id=$1', [id, progress, message ?? null]);
  }

  /** Terminal success: mark completed at now() with 100% progress and store the JSON result. */
  async complete(id: string, result: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      'update seo_sync_jobs set status=$2, completed_at=now(), progress=100, result=$3 where id=$1',
      [id, 'completed', JSON.stringify(result)],
    );
  }

  /**
   * Record a failure and decide between retry and terminal failure. A retryable
   * error with attempts left re-queues the job: started_at/completed_at are
   * cleared, retry_count is incremented and run_after is pushed out by the
   * exponential backoff (retryDelayMs), with the error kept on the row for the
   * UI. A non-retryable error (or exhausted retries) marks the job 'failed' at
   * now() and stores retry_count as one less than the attempts made - i.e. the
   * true number of retries that happened before the terminal failure, so the
   * counter is not inflated by the attempt that finally gave up.
   */
  async fail(id: string, errorPayload: JobRecord['error'], retryable: boolean): Promise<void> {
    const row = await this.pool.query('select retry_count, max_retries from seo_sync_jobs where id=$1', [id]);
    const retryCount = ((row.rows[0]?.retry_count as number) ?? 0) + 1;
    const maxRetries = (row.rows[0]?.max_retries as number) ?? 3;
    const willRetry = retryable && retryCount <= maxRetries;
    if (willRetry) {
      await this.pool.query(
        `update seo_sync_jobs
           set status='queued', started_at=null, completed_at=null, retry_count=$2,
               run_after=now() + ($3 || ' milliseconds')::interval, error=$4
         where id=$1`,
        [id, retryCount, retryDelayMs(retryCount - 1), JSON.stringify(errorPayload)],
      );
    } else {
      await this.pool.query(
        'update seo_sync_jobs set status=$2, completed_at=now(), retry_count=$3, error=$4 where id=$1',
        [id, 'failed', retryCount - 1, JSON.stringify(errorPayload)],
      );
    }
  }

  /** Mark a job canceled at now() - idempotent, and no retry will ever pick it up. */
  async cancel(id: string): Promise<void> {
    await this.pool.query('update seo_sync_jobs set status=$2, completed_at=now() where id=$1', [id, 'canceled']);
  }

  /**
   * Move a still-queued job to a new run_after. The UPDATE is conditioned on
   * status='queued' and returns false when it no longer matches (already
   * claimed/canceled/completed), so a caller that wanted to move a scheduled
   * job learns the move did not happen and can avoid creating a duplicate.
   */
  async reschedule(id: string, runAfter: string): Promise<boolean> {
    const result = await this.pool.query(
      `update seo_sync_jobs set run_after = $2 where id = $1 and status = 'queued'`,
      [id, new Date(runAfter).toISOString()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Marker that always throws 503. Used by wiring code that only ever expects
   * the supabase store but must typecheck against a pool-backed branch; the
   * store cannot function without a real pool, so reaching this is a config
   * error, not a runtime fallback.
   */
  static assertPool(): Pool {
    throw ApiError.notConfigured('Direct Postgres access is required for the pg job store');
  }
}
