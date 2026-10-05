/**
 * Admission-guarded JobStore decorator (P9).
 *
 * Every enqueue path in the application goes through `container.jobStore`:
 * the generic /jobs route, feature routes (content, keyword, research,
 * publishing, knowledge, schedules), the versioned API (/api/v1), MCP sessions,
 * agent-run reconciliation and the worker. Wrapping the store once at the
 * container boundary is therefore the single place where resource admission
 * cannot be forgotten by a new call site.
 *
 * The database trigger (`seo_admit_job`) is the atomic authority; this decorator
 * adds the application half - recognising a denial, recording denial evidence,
 * and throwing a stable structured error - while transparently delegating every
 * other JobStore operation. `events` is forwarded so the direct-Postgres
 * worker's LISTEN/NOTIFY wake-ups keep working through the wrapper.
 */

import type { EventEmitter } from 'node:events';
import type { JobError } from '@seo/contracts';
import type { EnqueueJobInput, JobRecord, JobStore } from './types.js';
import type { ResourceAdmissionService } from '../services/resourceAdmission.js';

export class GuardedJobStore implements JobStore {
  constructor(
    private readonly inner: JobStore,
    private readonly admission: ResourceAdmissionService,
  ) {}

  /**
   * Insert a job, translating a database admission denial into denial evidence
   * plus a structured `queue_limit` / `resource_concurrency` / `resource_limit`
   * error. Any unrelated error is rethrown untouched.
   */
  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    try {
      return await this.inner.enqueue(input);
    } catch (err) {
      const failure = this.admission.admissionErrorFrom(err);
      if (!failure) throw err;
      await this.admission.recordDenial({
        projectId: input.project_id,
        userId: input.created_by ?? null,
        resource: this.admission.classify(input.job_type),
        code: failure.code,
        scope: failure.scope,
        jobType: input.job_type,
      });
      throw this.admission.toApiError(failure, input.job_type);
    }
  }

  /** Forwarded verbatim from the wrapped store (worker LISTEN/NOTIFY wake-ups). */
  get events(): EventEmitter | undefined {
    return (this.inner as { events?: EventEmitter }).events;
  }

  claimNext(): Promise<JobRecord | null> {
    return this.inner.claimNext();
  }

  get(id: string): Promise<JobRecord | null> {
    return this.inner.get(id);
  }

  list(projectId: string, limit?: number): Promise<JobRecord[]> {
    return this.inner.list(projectId, limit);
  }

  updateProgress(id: string, progress: number, message?: string | null): Promise<void> {
    return this.inner.updateProgress(id, progress, message);
  }

  complete(id: string, result: Record<string, unknown>): Promise<void> {
    return this.inner.complete(id, result);
  }

  fail(id: string, error: JobError, retryable: boolean, result?: Record<string, unknown>): Promise<void> {
    return this.inner.fail(id, error, retryable, result);
  }

  cancel(id: string): Promise<void> {
    return this.inner.cancel(id);
  }

  reschedule(id: string, runAfter: string): Promise<boolean> {
    return this.inner.reschedule(id, runAfter);
  }
}
