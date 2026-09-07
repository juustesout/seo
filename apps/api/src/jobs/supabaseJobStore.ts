/**
 * JobStore backed by Supabase PostgREST (service role). The default when
 * SUPABASE_DB_URL is not configured.
 *
 * PostgREST cannot express SKIP LOCKED, so claiming is a compare-and-swap: pick
 * a small window of runnable candidates, then for each one attempt a conditional
 * UPDATE ... WHERE id = ? AND status = 'queued'. The UPDATE only claims the row
 * if no other worker changed it first, and the winner is whoever's UPDATE
 * returns a row - so a single worker or a small fleet never executes one job
 * twice from overlapping claim windows. It is deliberately weaker than the
 * direct-Postgres store (which uses one atomic SKIP LOCKED statement): under
 * heavy multi-worker contention the candidate read and the CAS update are not a
 * single transaction, which is why wiring prefers PostgresJobStore whenever a
 * pool is available. Idempotency-key duplicates surface as 409 conflicts here
 * so re-submitting deterministic work is reported, not silently duplicated.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';
import { retryDelayMs, type EnqueueJobInput, type JobRecord, type JobStore } from './types.js';

/**
 * Map a PostgREST row (already JSON, ISO timestamps) onto the shared JobRecord
 * shape, applying the same null-defaults as the pg store's mapRow so the two
 * backends behave identically to every caller.
 */
function rowToRecord(row: Record<string, unknown>): JobRecord {
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
    queued_at: row.queued_at as string,
    started_at: (row.started_at as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
    run_after: row.run_after as string,
    retry_count: (row.retry_count as number) ?? 0,
    max_retries: (row.max_retries as number) ?? 3,
    created_by: (row.created_by as string | null) ?? null,
  };
}

/**
 * PostgREST-backed JobStore (compare-and-swap claims, see module header).
 * Semantics for enqueue/get/list/progress/complete/fail/cancel/reschedule match
 * PostgresJobStore exactly; only the atomicity story differs.
 */
export class SupabaseJobStore implements JobStore {
  constructor(private readonly sb: SupabaseClient) {}

  /**
   * Insert one durable job row with the same fields and meaning as the pg
   * store. The schema's unique index on idempotency_key is surfaced here: a
   * duplicate insert is translated into a 409 conflict instead of a raw
   * PostgREST error, so a caller re-submitting deterministic work (same key)
   * learns that work already exists rather than creating a silent duplicate.
   */
  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const { data, error } = await this.sb
      .from('seo_sync_jobs')
      .insert({
        project_id: input.project_id,
        provider: input.provider,
        job_type: input.job_type,
        params: input.params ?? {},
        integration_id: input.integration_id ?? null,
        data_source_id: input.data_source_id ?? null,
        created_by: input.created_by ?? null,
        run_after: input.run_after ?? new Date().toISOString(),
        max_retries: input.max_retries ?? 3,
        idempotency_key: input.idempotency_key ?? null,
      } as never)
      .select()
      .single<Record<string, unknown>>();
    if (error) {
      if (String(error.message).toLowerCase().includes('duplicate') || String(error.code).includes('23505')) {
        throw ApiError.conflict('A job with the same idempotency key already exists');
      }
      logger.error({ error }, 'job enqueue failed');
      throw ApiError.badRequest('Could not queue job');
    }
    return rowToRecord(data);
  }

  /** Fetch one job by id, or null when it does not exist. */
  async get(id: string): Promise<JobRecord | null> {
    const { data, error } = await this.sb
      .from('seo_sync_jobs')
      .select('*')
      .eq('id', id)
      .maybeSingle<Record<string, unknown>>();
    if (error || !data) return null;
    return rowToRecord(data);
  }

  /** Most recent jobs for a project, newest first (limit clamped to 200) - the jobs UI/API read path. */
  async list(projectId: string, limit = 50): Promise<JobRecord[]> {
    const { data, error } = await this.sb
      .from('seo_sync_jobs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(200, limit)));
    if (error) {
      logger.error({ error }, 'job list failed');
      throw ApiError.badRequest('Could not read jobs');
    }
    return (data ?? []).map((row) => rowToRecord(row as Record<string, unknown>));
  }

  /**
   * Compare-and-swap claim. Read up to 5 runnable candidates (oldest queued
   * first, run_after passed), then for each try a conditional UPDATE ...
   * WHERE id AND status='queued'. Only one worker's UPDATE matches a given row -
   * the row leaves 'queued' at the first winner, so every later CAS on it
   * updates zero rows and the next candidate is tried. The winner is the caller
   * whose UPDATE returns the row. This is safe for one or a few workers; the
   * read-then-update window means it is not a substitute for SKIP LOCKED under
   * heavy contention (see module header). Returns null when nothing is
   * claimable.
   */
  async claimNext(): Promise<JobRecord | null> {
    const now = new Date().toISOString();
    const { data: candidates, error } = await this.sb
      .from('seo_sync_jobs')
      .select('*')
      .eq('status', 'queued')
      .lte('run_after', now)
      .order('queued_at', { ascending: true })
      .limit(5);
    if (error) {
      logger.error({ error }, 'job claim select failed');
      return null;
    }
    if (!candidates || candidates.length === 0) return null;
    for (const candidate of candidates as Record<string, unknown>[]) {
      const { data: claimed } = await this.sb
        .from('seo_sync_jobs')
        .update({ status: 'running', started_at: now })
        .eq('id', candidate.id as string)
        .eq('status', 'queued')
        .select()
        .single<Record<string, unknown>>();
      if (claimed) return rowToRecord(claimed);
    }
    return null;
  }

  /** Persist 0-100 progress plus an optional human-readable message (live job feed). */
  async updateProgress(id: string, progress: number, message?: string | null): Promise<void> {
    await this.sb
      .from('seo_sync_jobs')
      .update({ progress, message: message ?? null })
      .eq('id', id);
  }

  /** Terminal success: mark completed at now with 100% progress and store the JSON result. */
  async complete(id: string, result: Record<string, unknown>): Promise<void> {
    await this.sb
      .from('seo_sync_jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), progress: 100, result })
      .eq('id', id);
  }

  /**
   * Record a failure and decide between retry and terminal failure - same
   * bookkeeping as the pg store. A retryable error with attempts left re-queues
   * the job with started_at/completed_at cleared, retry_count incremented and
   * run_after pushed out by the exponential backoff (retryDelayMs). A non-
   * retryable error or exhausted retries marks the job 'failed' and stores
   * retry_count as one less than the attempts made (the real number of retries
   * before the terminal failure).
   */
  async fail(id: string, errorPayload: JobRecord['error'], retryable: boolean): Promise<void> {
    const { data: row } = await this.sb
      .from('seo_sync_jobs')
      .select('retry_count, max_retries')
      .eq('id', id)
      .single<{ retry_count: number; max_retries: number }>();
    const retryCount = (row?.retry_count ?? 0) + 1;
    const maxRetries = row?.max_retries ?? 3;
    const willRetry = retryable && retryCount <= maxRetries;
    if (willRetry) {
      await this.sb
        .from('seo_sync_jobs')
        .update({
          status: 'queued',
          started_at: null,
          completed_at: null,
          retry_count: retryCount,
          run_after: new Date(Date.now() + retryDelayMs(retryCount - 1)).toISOString(),
          error: errorPayload,
        })
        .eq('id', id);
    } else {
      await this.sb
        .from('seo_sync_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          retry_count: retryCount - 1,
          error: errorPayload,
        })
        .eq('id', id);
    }
  }

  /** Mark a job canceled at now - idempotent, and no retry will ever pick it up. */
  async cancel(id: string): Promise<void> {
    await this.sb
      .from('seo_sync_jobs')
      .update({ status: 'canceled', completed_at: new Date().toISOString() })
      .eq('id', id);
  }

  /**
   * Move a still-queued job to a new run_after; the conditional UPDATE only
   * matches status='queued' rows, and the returned id (or its absence) tells
   * the caller whether the move actually happened - false when the job was
   * already claimed/canceled/completed, so callers avoid creating a duplicate.
   */
  async reschedule(id: string, runAfter: string): Promise<boolean> {
    const { data, error } = await this.sb
      .from('seo_sync_jobs')
      .update({ run_after: runAfter })
      .eq('id', id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle<Record<string, unknown>>();
    if (error) {
      logger.error({ error }, 'job reschedule failed');
      throw ApiError.badRequest('Could not reschedule job');
    }
    return Boolean(data);
  }
}
