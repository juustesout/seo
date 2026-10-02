/**
 * Worker job usage instrumentation (R5.10.4, Layer B).
 *
 * Pins that a terminal job execution records exactly one job usage fact, that a
 * retryable failure still waiting to retry records none, and that re-executing
 * the same job does not multiply the fact.
 */
import { describe, expect, it, vi } from 'vitest';
import type { JobRecord } from './jobs/types.js';
import { InMemoryUsageEventStore } from './services/usageEventRepository.js';

const h = vi.hoisted(() => ({ executor: null as null | ((args: unknown) => Promise<Record<string, unknown>>) }));

vi.mock('./jobs/executors.js', () => ({ getExecutor: () => h.executor }));

import { runOnce } from './worker.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    id: JOB_ID,
    project_id: PROJECT,
    integration_id: null,
    data_source_id: null,
    provider: 'dataforseo',
    job_type: 'dataforseo_rank_sync',
    status: 'running',
    params: {},
    progress: 0,
    message: null,
    result: null,
    error: null,
    queued_at: now,
    started_at: new Date(Date.now() - 250).toISOString(),
    completed_at: null,
    run_after: now,
    retry_count: 0,
    max_retries: 3,
    created_by: null,
    ...overrides,
  };
}

function container(store: InMemoryUsageEventStore, record: JobRecord, executor: (args: unknown) => Promise<Record<string, unknown>>) {
  h.executor = executor;
  const complete = vi.fn(async () => {});
  const fail = vi.fn(async () => {});
  return {
    container: {
      jobStore: {
        claimNext: async () => record,
        updateProgress: async () => {},
        complete,
        fail,
      },
      sb: {},
      usageEvents: store,
      config: { retry: { perJobBudget: 4 } },
    } as unknown as Parameters<typeof runOnce>[0],
    complete,
    fail,
  };
}

describe('worker job usage', () => {
  it('records one completed job fact with retry count and duration', async () => {
    const store = new InMemoryUsageEventStore();
    const { container: c, complete } = container(store, job(), async () => ({ ok: true }));
    expect(await runOnce(c)).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'job',
      provider: 'dataforseo',
      operation: 'dataforseo_rank_sync',
      unit: 'job',
      quantity: 1,
      success: true,
      sourceId: JOB_ID,
      metadata: { retryCount: 0, status: 'completed' },
    });
    expect((events[0]!.metadata as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a terminal failure', async () => {
    const store = new InMemoryUsageEventStore();
    const failure = Object.assign(new Error('bad request'), { status: 400 });
    const { container: c, fail } = container(store, job(), async () => {
      throw failure;
    });
    await runOnce(c);
    expect(fail).toHaveBeenCalledTimes(1);

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ success: false, unit: 'job', metadata: { retryCount: 0, status: 'failed' } });
  });

  it('records nothing for a retryable failure that will be retried', async () => {
    const store = new InMemoryUsageEventStore();
    const failure = Object.assign(new Error('vendor down'), { status: 500 });
    const { container: c } = container(store, job(), async () => {
      throw failure;
    });
    await runOnce(c);
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('does not multiply the fact when the same job is executed again', async () => {
    const store = new InMemoryUsageEventStore();
    const { container: c } = container(store, job(), async () => ({ ok: true }));
    await runOnce(c);
    await runOnce(c);
    expect(await store.list({ projectId: PROJECT })).toHaveLength(1);
  });
});
