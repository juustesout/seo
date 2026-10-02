/**
 * Worker dispatch (deploy-race hardening). A job whose type has no registered
 * executor must be requeued (retryable) rather than permanently failed: a worker
 * still running the previous release during a deploy race must not consume a
 * valid job that a current worker can run.
 */
import { describe, expect, it, vi } from 'vitest';
import { runOnce, sweepStaleRunning } from './worker.js';
import type { JobRecord } from './jobs/types.js';

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    id: 'job-1',
    project_id: 'p1',
    integration_id: null,
    data_source_id: null,
    provider: 'dataforseo',
    job_type: 'definitely_not_a_real_job_type',
    status: 'running',
    params: {},
    progress: 0,
    message: null,
    result: null,
    error: null,
    queued_at: now,
    started_at: now,
    completed_at: null,
    run_after: now,
    retry_count: 0,
    max_retries: 3,
    created_by: null,
    ...overrides,
  };
}

function fakeContainer(args: {
  claimNext: () => Promise<JobRecord | null>;
  fail: (id: string, error: { code?: string | null }, retryable: boolean) => Promise<void>;
}): Parameters<typeof runOnce>[0] {
  return { jobStore: args, sb: {} } as unknown as Parameters<typeof runOnce>[0];
}

describe('worker unknown job type', () => {
  it('requeues an unregistered job type instead of failing it permanently', async () => {
    const fail = vi.fn(async (_id: string, _error: { code?: string | null }, _retryable: boolean) => {});
    const claimNext = vi.fn(async () => job());
    const container = fakeContainer({ claimNext, fail });

    expect(await runOnce(container)).toBe(true);
    expect(fail).toHaveBeenCalledTimes(1);
    const [id, error, retryable] = fail.mock.calls[0]!;
    expect(id).toBe('job-1');
    expect(error.code).toBe('unsupported_job_type');
    expect(retryable).toBe(true);
  });

  it('does nothing when the queue is empty', async () => {
    const fail = vi.fn(async (_id: string, _error: { code?: string | null }, _retryable: boolean) => {});
    const claimNext = vi.fn(async () => null);
    const container = fakeContainer({ claimNext, fail });

    expect(await runOnce(container)).toBe(false);
    expect(fail).not.toHaveBeenCalled();
  });
});

describe('worker stale running sweep', () => {
  type StaleRow = {
    id: string;
    provider: string | null;
    job_type: string;
    retry_count: number | null;
    max_retries: number | null;
  };

  function staleContainer(result: { data: StaleRow[] | null; error: unknown }, fail: ReturnType<typeof vi.fn>) {
    const lte = vi.fn(async () => result);
    const eq = vi.fn(() => ({ lte }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    return { jobStore: { fail }, sb: { from } } as unknown as Parameters<typeof sweepStaleRunning>[0];
  }

  it('recovers each stale job through the store failure path instead of blind requeue', async () => {
    const fail = vi.fn(async (_id: string, _error: { code?: string | null }, _retryable: boolean) => {});
    const container = staleContainer(
      {
        data: [{ id: 'j1', provider: 'dataforseo', job_type: 'sync', retry_count: 0, max_retries: 3 }],
        error: null,
      },
      fail,
    );

    await sweepStaleRunning(container);

    expect(fail).toHaveBeenCalledTimes(1);
    const [id, error, retryable] = fail.mock.calls[0]!;
    expect(id).toBe('j1');
    expect(error.code).toBe('stale_worker');
    expect(retryable).toBe(true);
  });

  it('does nothing when there is no stale job', async () => {
    const fail = vi.fn(async (_id: string, _error: { code?: string | null }, _retryable: boolean) => {});
    const container = staleContainer({ data: [], error: null }, fail);

    await sweepStaleRunning(container);

    expect(fail).not.toHaveBeenCalled();
  });

  it('returns without touching jobs when the query fails', async () => {
    const fail = vi.fn(async (_id: string, _error: { code?: string | null }, _retryable: boolean) => {});
    const container = staleContainer({ data: null, error: { message: 'boom' } }, fail);

    await sweepStaleRunning(container);

    expect(fail).not.toHaveBeenCalled();
  });

  it('keeps sweeping the remaining jobs when one recovery fails', async () => {
    const fail = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('store down');
    });
    const container = staleContainer(
      {
        data: [
          { id: 'bad', provider: null, job_type: 'sync', retry_count: 0, max_retries: 3 },
          { id: 'good', provider: null, job_type: 'sync', retry_count: 0, max_retries: 3 },
        ],
        error: null,
      },
      fail,
    );

    await sweepStaleRunning(container);

    expect(fail).toHaveBeenCalledTimes(2);
  });
});
