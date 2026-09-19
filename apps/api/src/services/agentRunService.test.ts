import { describe, expect, it, vi } from 'vitest';
import type { DesignerPlan } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import type { EnqueueJobInput, JobRecord, JobStore } from '../jobs/types.js';
import { InMemoryAgentRunRepository } from './agentRunRepository.js';
import { AgentRunService, AGENT_DESIGN_JOB_TYPE, AGENT_DESIGN_JOB_PROVIDER } from './agentRunService.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CONTENT = '33333333-3333-4333-8333-333333333333';
const plan: DesignerPlan = { version: 1, steps: [{ kind: 'designer.review', criteria: ['document_valid'] }] };

function fakeJobStore(behavior?: (input: EnqueueJobInput) => Promise<JobRecord>): {
  store: JobStore;
  calls: EnqueueJobInput[];
} {
  const calls: EnqueueJobInput[] = [];
  const store = {
    enqueue: async (input: EnqueueJobInput) => {
      calls.push(input);
      if (behavior) return behavior(input);
      return { id: 'job-1', project_id: input.project_id } as JobRecord;
    },
  } as unknown as JobStore;
  return { store, calls };
}

function containerWith(store: JobStore): ServiceContainer {
  return { sb: {}, jobStore: store } as unknown as ServiceContainer;
}

describe('AgentRunService.submitDesignRun', () => {
  it('persists a queued plan run and associates its job', async () => {
    const { store, calls } = fakeJobStore();
    const repo = new InMemoryAgentRunRepository();
    const service = new AgentRunService(containerWith(store), repo);

    const result = await service.submitDesignRun(PROJECT, 'user-1', {
      mode: 'plan',
      plan,
      baseRevision: 'rev1:abc',
    });

    expect(result.reused).toBe(false);
    expect(result.run.status).toBe('queued');
    expect(result.run.kind).toBe('design');
    expect(result.run.input).toMatchObject({ mode: 'plan', baseRevision: 'rev1:abc' });
    expect(result.run.result).toBeNull();
    expect(result.run.error).toBeNull();

    const stored = await repo.getBound(result.run.runId, PROJECT);
    expect(stored?.jobId).toBe('job-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      project_id: PROJECT,
      provider: AGENT_DESIGN_JOB_PROVIDER,
      job_type: AGENT_DESIGN_JOB_TYPE,
      params: { run_id: result.run.runId, kind: 'design' },
    });
    expect(calls[0]!.idempotency_key).toBe(`${AGENT_DESIGN_JOB_TYPE}:${result.run.runId}`);
  });

  it('stores an intent run with the project bound server-side', async () => {
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), new InMemoryAgentRunRepository());

    const result = await service.submitDesignRun(PROJECT, 'user-1', {
      mode: 'intent',
      instruction: 'Make it punchier',
      contentId: CONTENT,
    });

    expect(result.run.input).toEqual({
      mode: 'intent',
      intent: { instruction: 'Make it punchier', projectId: PROJECT, contentId: CONTENT },
    });
  });

  it('collapses a duplicate idempotency key onto the existing run and job', async () => {
    const { store, calls } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), new InMemoryAgentRunRepository());

    const first = await service.submitDesignRun(PROJECT, 'user-1', {
      mode: 'plan',
      plan,
      baseRevision: 'rev1:abc',
      idempotencyKey: 'k1',
    });
    const second = await service.submitDesignRun(PROJECT, 'user-1', {
      mode: 'plan',
      plan,
      baseRevision: 'rev1:abc',
      idempotencyKey: 'k1',
    });

    expect(second.reused).toBe(true);
    expect(second.run.runId).toBe(first.run.runId);
    expect(calls).toHaveLength(1);
  });

  it('reuses the winner when a concurrent insert wins the key', async () => {
    const { store, calls } = fakeJobStore();
    const repo = new InMemoryAgentRunRepository();
    const service = new AgentRunService(containerWith(store), repo);

    const spy = vi.spyOn(repo, 'insert').mockImplementationOnce(async (run) => {
      // The winner lands first with the same key, then this insert conflicts.
      await InMemoryAgentRunRepository.prototype.insert.call(repo, {
        ...run,
        runId: 'ar_55555555-5555-4555-8555-555555555555',
      });
      throw ApiError.conflict('duplicate');
    });

    const result = await service.submitDesignRun(PROJECT, 'user-1', {
      mode: 'plan',
      plan,
      baseRevision: 'rev1:abc',
      idempotencyKey: 'k-race',
    });
    spy.mockRestore();

    expect(result.reused).toBe(true);
    expect(result.run.runId).toBe('ar_55555555-5555-4555-8555-555555555555');
    expect(calls).toHaveLength(0);
  });

  it('fails the run honestly when the job cannot be enqueued', async () => {
    const failure = ApiError.notConfigured('no job worker');
    const { store } = fakeJobStore(async () => {
      throw failure;
    });
    const repo = new InMemoryAgentRunRepository();
    const service = new AgentRunService(containerWith(store), repo);

    await expect(
      service.submitDesignRun(PROJECT, 'user-1', {
        mode: 'plan',
        plan,
        baseRevision: 'rev1:abc',
        idempotencyKey: 'k-enqueue-fail',
      }),
    ).rejects.toBe(failure);

    const failed = await repo.getByProjectAndKey(PROJECT, 'k-enqueue-fail');
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.code).toBe('not_configured');
    expect(failed?.completedAt).not.toBeNull();
  });

  it('rejects a base revision combined with a content id', async () => {
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), new InMemoryAgentRunRepository());
    await expect(
      service.submitDesignRun(PROJECT, 'user-1', {
        mode: 'plan',
        plan,
        contentId: CONTENT,
        baseRevision: 'rev1:abc',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});
