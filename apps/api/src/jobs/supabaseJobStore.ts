/**
 * JobStore backed by Supabase PostgREST (service role). Suitable for a single
 * worker or a handful of workers with overlapping claims - claim is made
 * safe-ish via a compare-and-swap update on (id,status='queued').
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';
import { retryDelayMs, type EnqueueJobInput, type JobRecord, type JobStore } from './types.js';

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

export class SupabaseJobStore implements JobStore {
  constructor(private readonly sb: SupabaseClient) {}

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

  async get(id: string): Promise<JobRecord | null> {
    const { data, error } = await this.sb
      .from('seo_sync_jobs')
      .select('*')
      .eq('id', id)
      .maybeSingle<Record<string, unknown>>();
    if (error || !data) return null;
    return rowToRecord(data);
  }

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

  async updateProgress(id: string, progress: number, message?: string | null): Promise<void> {
    await this.sb
      .from('seo_sync_jobs')
      .update({ progress, message: message ?? null })
      .eq('id', id);
  }

  async complete(id: string, result: Record<string, unknown>): Promise<void> {
    await this.sb
      .from('seo_sync_jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), progress: 100, result })
      .eq('id', id);
  }

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

  async cancel(id: string): Promise<void> {
    await this.sb
      .from('seo_sync_jobs')
      .update({ status: 'canceled', completed_at: new Date().toISOString() })
      .eq('id', id);
  }
}
