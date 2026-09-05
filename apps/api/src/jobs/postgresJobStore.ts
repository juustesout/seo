/**
 * JobStore backed by direct Postgres (when SUPABASE_DB_URL is set). Uses a real
 * atomic claim (SKIP LOCKED) so any number of workers can safely share the
 * queue, plus LISTEN/NOTIFY so workers wake instantly on new jobs.
 */

import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { ApiError } from '../apiErrors.js';
import { retryDelayMs, type EnqueueJobInput, type JobRecord, type JobStore } from './types.js';
import { logger } from '../logger.js';

const JOB_COLUMNS = `id, project_id, integration_id, data_source_id, provider, job_type,
  status, params, progress, message, result, error,
  to_char(queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS queued_at,
  started_at, completed_at, run_after, retry_count, max_retries, created_by`;

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

export class PostgresJobStore implements JobStore {
  readonly events = new EventEmitter();

  constructor(private readonly pool: Pool) {
    this.pool.connect().then((client) => {
      client.on('error', (err) => logger.error({ err }, 'pg notify client error'));
      client.query('LISTEN seo_jobs_channel').catch((err) => logger.error({ err }, 'LISTEN failed'));
      client.on('notification', () => {
        this.events.emit('job');
      });
    });
  }

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

  async get(id: string): Promise<JobRecord | null> {
    const result = await this.pool.query(`select ${JOB_COLUMNS} from seo_sync_jobs where id = $1`, [id]);
    return mapRow(result.rows[0]);
  }

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

  async updateProgress(id: string, progress: number, message?: string | null): Promise<void> {
    await this.pool.query('update seo_sync_jobs set progress=$2, message=$3 where id=$1', [id, progress, message ?? null]);
  }

  async complete(id: string, result: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      'update seo_sync_jobs set status=$2, completed_at=now(), progress=100, result=$3 where id=$1',
      [id, 'completed', JSON.stringify(result)],
    );
  }

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

  async cancel(id: string): Promise<void> {
    await this.pool.query('update seo_sync_jobs set status=$2, completed_at=now() where id=$1', [id, 'canceled']);
  }

  static assertPool(): Pool {
    throw ApiError.notConfigured('Direct Postgres access is required for the pg job store');
  }
}
