/**
 * Durable agent run execution + reconciliation (ADR Phase 4 Part 2).
 *
 * Exercises the `agent_design` lifecycle body directly: claim, Designer
 * invocation (plan and intent modes), result persistence, retry-aware failure
 * marking, terminal-run protection and the orphaned-run sweep. The Designer
 * boundary is mocked because these tests are about the run lifecycle, not the
 * Designer itself; the repository is the real in-memory implementation so its
 * optimistic transitions are part of the contract under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunId, DesignerPlan, DesignerProposal } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import type { EnqueueJobInput, JobRecord, JobStore } from '../jobs/types.js';
import { InMemoryAgentRunRepository, type NewAgentRun } from './agentRunRepository.js';
import {
  AgentRunService,
  AGENT_DESIGN_JOB_PROVIDER,
  AGENT_DESIGN_JOB_TYPE,
} from './agentRunService.js';

const designer = vi.hoisted(() => ({
  constructed: [] as unknown[],
  executes: [] as Array<{ projectId: string; input: unknown }>,
  intents: [] as Array<{ projectId: string; intent: unknown; options: unknown }>,
  proposal: null as unknown,
  error: null as unknown,
}));

vi.mock('./designerService.js', () => ({
  DesignerService: class {
    constructor(_container: unknown, options: unknown) {
      designer.constructed.push(options);
    }
    async execute(projectId: string, input: unknown) {
      designer.executes.push({ projectId, input });
      if (designer.error) throw designer.error;
      return designer.proposal;
    }
    async executeIntent(projectId: string, intent: unknown, options: unknown) {
      designer.intents.push({ projectId, intent, options });
      if (designer.error) throw designer.error;
      return designer.proposal;
    }
  },
}));

const PROJECT = '11111111-1111-4111-8111-111111111111';
const RUN_ID: AgentRunId = 'ar_22222222-2222-4222-8222-222222222222';

const plan: DesignerPlan = { version: 1, steps: [{ kind: 'designer.review', criteria: ['document_valid'] }] };
const proposal: DesignerProposal = {
  version: 1,
  baseRevision: 'rev1:abc',
  document: { version: 1, blocks: [{ type: 'paragraph' }] },
};

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    id: 'job-1',
    project_id: PROJECT,
    integration_id: null,
    data_source_id: null,
    provider: AGENT_DESIGN_JOB_PROVIDER,
    job_type: AGENT_DESIGN_JOB_TYPE,
    status: 'running',
    params: { run_id: RUN_ID, kind: 'design' },
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
    created_by: 'user-1',
    ...overrides,
  };
}

function fakeJobStore(behavior?: (input: EnqueueJobInput) => Promise<JobRecord>): {
  store: JobStore;
  enqueued: EnqueueJobInput[];
} {
  const enqueued: EnqueueJobInput[] = [];
  const store = {
    enqueue: async (input: EnqueueJobInput) => {
      enqueued.push(input);
      if (behavior) return behavior(input);
      return { id: 'job-1', project_id: input.project_id } as JobRecord;
    },
  } as unknown as JobStore;
  return { store, enqueued };
}

function containerWith(store: JobStore): ServiceContainer {
  return { sb: {}, jobStore: store } as unknown as ServiceContainer;
}

async function seedRun(
  repo: InMemoryAgentRunRepository,
  overrides: Partial<NewAgentRun> = {},
): Promise<void> {
  await repo.insert({
    runId: RUN_ID,
    accountId: null,
    projectId: PROJECT,
    kind: 'design',
    status: 'queued',
    input: { mode: 'plan', plan, baseRevision: 'rev1:abc' },
    idempotencyKey: null,
    userId: 'user-1',
    ...overrides,
  });
}

const noopReport = async () => {};

beforeEach(() => {
  designer.constructed = [];
  designer.executes = [];
  designer.intents = [];
  designer.proposal = proposal;
  designer.error = null;
});

describe('AgentRunService.executeDesignRun', () => {
  it('claims a queued run, executes the plan and persists the succeeded result', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);

    const result = await service.executeDesignRun(job(), noopReport);

    expect(result).toMatchObject({ run_id: RUN_ID, status: 'succeeded' });
    const row = await repo.getBound(RUN_ID, PROJECT);
    expect(row?.status).toBe('succeeded');
    expect(row?.result?.baseRevision).toBe('rev1:abc');
    expect(row?.error).toBeNull();
    expect(row?.completedAt).not.toBeNull();
    expect(designer.executes).toEqual([
      {
        projectId: PROJECT,
        input: { plan, baseRevision: 'rev1:abc' },
      },
    ]);
  });

  it('executes intent mode through the LLM planner', async () => {
    const repo = new InMemoryAgentRunRepository();
    await repo.insert({
      runId: RUN_ID,
      accountId: null,
      projectId: PROJECT,
      kind: 'design',
      status: 'queued',
      input: {
        mode: 'intent',
        intent: { instruction: 'Make it punchier', projectId: PROJECT },
        baseRevision: 'rev1:abc',
      },
      idempotencyKey: null,
      userId: 'user-1',
    });
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);

    await service.executeDesignRun(job(), noopReport);

    expect(designer.constructed).toContainEqual({ llmPlanner: true });
    expect(designer.intents).toEqual([
      {
        projectId: PROJECT,
        intent: { instruction: 'Make it punchier', projectId: PROJECT },
        options: { baseRevision: 'rev1:abc' },
      },
    ]);
    expect((await repo.getBound(RUN_ID, PROJECT))?.status).toBe('succeeded');
  });

  it('keeps a retryable run running when the job still has attempts left', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);
    const failure = new ApiError(502, 'designer_planner_failed', 'planner unavailable');
    designer.error = failure;

    await expect(service.executeDesignRun(job({ retry_count: 0, max_retries: 3 }), noopReport)).rejects.toBe(failure);

    const row = await repo.getBound(RUN_ID, PROJECT);
    expect(row?.status).toBe('running');
    expect(row?.error).toBeNull();
    expect(row?.completedAt).toBeNull();
  });

  it('fails the run with a structured error when retries are exhausted', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);
    designer.error = new ApiError(502, 'designer_planner_failed', 'planner unavailable');

    await expect(service.executeDesignRun(job({ retry_count: 3, max_retries: 3 }), noopReport)).rejects.toMatchObject({
      code: 'designer_planner_failed',
    });

    const row = await repo.getBound(RUN_ID, PROJECT);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatchObject({ code: 'designer_planner_failed', retryable: true });
    expect(row?.completedAt).not.toBeNull();
  });

  it('fails the run immediately on a non-retryable failure', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);
    designer.error = ApiError.notConfigured('No AI provider is configured');

    await expect(service.executeDesignRun(job(), noopReport)).rejects.toMatchObject({ code: 'not_configured' });

    const row = await repo.getBound(RUN_ID, PROJECT);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatchObject({ code: 'not_configured', retryable: false });
  });

  it('re-enters a run that a prior retry attempt left running', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    await repo.transition({ runId: RUN_ID, projectId: PROJECT, from: ['queued'], to: 'running' });
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);

    await service.executeDesignRun(job(), noopReport);

    expect(designer.executes).toHaveLength(1);
    expect((await repo.getBound(RUN_ID, PROJECT))?.status).toBe('succeeded');
  });

  it('never re-executes an already succeeded run', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    await repo.transition({
      runId: RUN_ID,
      projectId: PROJECT,
      from: ['queued'],
      to: 'succeeded',
      result: proposal,
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);

    const result = await service.executeDesignRun(job(), noopReport);

    expect(result).toMatchObject({ status: 'succeeded', already_terminal: true });
    expect(designer.executes).toHaveLength(0);
  });

  it('reports a terminal failed run without re-executing it', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    await repo.transition({
      runId: RUN_ID,
      projectId: PROJECT,
      from: ['queued'],
      to: 'failed',
      error: { code: 'designer_planner_failed', message: 'planner unavailable' },
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);

    await expect(service.executeDesignRun(job(), noopReport)).rejects.toMatchObject({
      code: 'agent_run_terminal_failed',
    });
    expect(designer.executes).toHaveLength(0);
  });

  it('fails a job whose run is not bound to its project', async () => {
    const repo = new InMemoryAgentRunRepository();
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);

    await expect(service.executeDesignRun(job(), noopReport)).rejects.toMatchObject({ code: 'agent_run_not_found' });
    expect(designer.executes).toHaveLength(0);
  });

  it('rejects a job without a valid run id', async () => {
    const repo = new InMemoryAgentRunRepository();
    const { store } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);

    await expect(
      service.executeDesignRun(job({ params: { run_id: 'not-a-run' } }), noopReport),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('AgentRunService.reconcileOrphanedRuns', () => {
  it('adopts a jobless queued run and associates the reused job', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    const { store, enqueued } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);

    const result = await service.reconcileOrphanedRuns({ olderThanMs: -1 });

    expect(result).toEqual({ examined: 1, reconciled: 1, skipped: 0 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      project_id: PROJECT,
      provider: AGENT_DESIGN_JOB_PROVIDER,
      job_type: AGENT_DESIGN_JOB_TYPE,
      params: { run_id: RUN_ID, kind: 'design' },
      idempotency_key: `${AGENT_DESIGN_JOB_TYPE}:${RUN_ID}`,
    });
    expect((await repo.getBound(RUN_ID, PROJECT))?.jobId).toBe('job-1');
  });

  it('is repeat-safe: an adopted run is never reconciled twice', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    const { store, enqueued } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);

    await service.reconcileOrphanedRuns({ olderThanMs: -1 });
    const second = await service.reconcileOrphanedRuns({ olderThanMs: -1 });

    expect(second.examined).toBe(0);
    expect(enqueued).toHaveLength(1);
  });

  it('leaves a fresh run inside the grace window alone', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    const { store, enqueued } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);

    const result = await service.reconcileOrphanedRuns({ olderThanMs: 60_000 });

    expect(result.examined).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('fails closed when an equivalent job already exists', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    const { store, enqueued } = fakeJobStore(async () => {
      throw ApiError.conflict('A job with the same idempotency key already exists');
    });
    const service = new AgentRunService(containerWith(store), repo);

    const result = await service.reconcileOrphanedRuns({ olderThanMs: -1 });

    expect(result).toEqual({ examined: 1, reconciled: 0, skipped: 1 });
    expect(enqueued).toHaveLength(1);
    expect((await repo.getBound(RUN_ID, PROJECT))?.jobId).toBeNull();
  });

  it('does not touch runs that already have a job', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seedRun(repo);
    await repo.setJobId(RUN_ID, PROJECT, 'job-existing');
    const { store, enqueued } = fakeJobStore();
    const service = new AgentRunService(containerWith(store), repo);

    const result = await service.reconcileOrphanedRuns({ olderThanMs: -1 });

    expect(result.examined).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});
