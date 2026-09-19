/**
 * `agent_design` executor registration + delegation (ADR Phase 4 Part 2). The
 * executor must exist in the shared registry and forward the claimed job and its
 * progress reporter straight into the durable run service, where all lifecycle
 * policy lives.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from './types.js';

const runs = vi.hoisted(() => ({
  calls: [] as Array<{ job: unknown; report: unknown }>,
  result: { run_id: 'ar_x', status: 'succeeded' } as Record<string, unknown>,
  error: null as unknown,
}));

vi.mock('../services/agentRunService.js', () => ({
  AgentRunService: class {
    async executeDesignRun(job: unknown, report: unknown) {
      runs.calls.push({ job, report });
      if (runs.error) throw runs.error;
      return runs.result;
    }
  },
}));

import { getExecutor } from './executors.js';

function job(): JobRecord {
  const now = new Date().toISOString();
  return {
    id: 'job-1',
    project_id: 'p1',
    integration_id: null,
    data_source_id: null,
    provider: 'designer',
    job_type: 'agent_design',
    status: 'running',
    params: { run_id: 'ar_22222222-2222-4222-8222-222222222222' },
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
  };
}

beforeEach(() => {
  runs.calls = [];
  runs.error = null;
});

describe('agent_design executor', () => {
  it('is registered under the agent_design job type', () => {
    expect(getExecutor('agent_design')).toBeTypeOf('function');
  });

  it('delegates the job and reporter to the durable run service', async () => {
    const executor = getExecutor('agent_design')!;
    const record = job();
    const report = vi.fn(async () => {});
    const result = await executor({ container: {} as never, job: record, writer: {} as never, report });

    expect(runs.calls).toHaveLength(1);
    expect(runs.calls[0]!.job).toBe(record);
    expect(runs.calls[0]!.report).toBe(report);
    expect(result).toEqual(runs.result);
  });
});
