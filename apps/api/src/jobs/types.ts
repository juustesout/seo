/**
 * Job domain types + queue contract. The queue is deliberately thin: jobs are
 * durable rows in seo_sync_jobs; the worker claims them atomically. This makes
 * it possible to swap the execution transport (in-process worker today, a
 * dedicated worker fleet, pg-boss, Temporal...) without touching the domain.
 */

import type { JobError } from '@seo/contracts';

export interface JobRecord {
  id: string;
  project_id: string;
  integration_id: string | null;
  data_source_id: string | null;
  provider: string;
  job_type: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  params: Record<string, unknown>;
  progress: number;
  message: string | null;
  result: Record<string, unknown> | null;
  error: JobError | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  run_after: string;
  retry_count: number;
  max_retries: number;
  created_by: string | null;
}

export interface EnqueueJobInput {
  project_id: string;
  provider: string;
  job_type: string;
  params?: Record<string, unknown>;
  integration_id?: string | null;
  data_source_id?: string | null;
  created_by?: string | null;
  run_after?: string;
  max_retries?: number;
  idempotency_key?: string;
}

export interface JobStore {
  enqueue(input: EnqueueJobInput): Promise<JobRecord>;
  claimNext(): Promise<JobRecord | null>;
  get(id: string): Promise<JobRecord | null>;
  /** Most recent jobs for a project, newest first. */
  list(projectId: string, limit?: number): Promise<JobRecord[]>;
  updateProgress(id: string, progress: number, message?: string | null): Promise<void>;
  complete(id: string, result: Record<string, unknown>): Promise<void>;
  fail(id: string, error: JobError, retryable: boolean): Promise<void>;
  cancel(id: string): Promise<void>;
  /**
   * Move a still-queued job to a new run time. Returns false when the job is no
   * longer queued (already claimed/canceled/completed) so callers can refuse
   * rescheduling without creating a second job.
   */
  reschedule(id: string, runAfter: string): Promise<boolean>;
}

/** Exponential retry backoff (capped at 1h). */
export function retryDelayMs(retryCount: number): number {
  const base = 30_000;
  return Math.min(base * 2 ** Math.max(0, retryCount), 3_600_000);
}

/** Structured error payload recorded on the job row (never contains secrets). */
export function jobErrorPayload(
  err: unknown,
  meta: { provider?: string; operation?: string; project_id: string; job_type: string },
): { error: JobError; retryable: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  const code = (err as { code?: string })?.code;
  const explicit = (err as { retryable?: boolean })?.retryable;
  let retryable: boolean;
  if (explicit !== undefined) {
    retryable = explicit;
  } else if (code && PERMANENT_CODES.has(code)) {
    retryable = false;
  } else if (status !== undefined) {
    retryable = status >= 500 || status === 429;
  } else {
    // No HTTP status + no application code -> transport-level failure.
    retryable = true;
  }
  return {
    error: {
      provider: meta.provider,
      operation: meta.operation,
      message,
      http_status: typeof status === 'number' ? status : null,
      code: code ?? null,
      retryable,
      occurred_at: new Date().toISOString(),
    },
    retryable,
  };
}

const PERMANENT_CODES = new Set([
  'not_configured',
  'unsupported_job_type',
  'validation_error',
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'invalid_credentials',
]);
