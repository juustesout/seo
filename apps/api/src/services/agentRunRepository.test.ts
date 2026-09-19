import { describe, expect, it } from 'vitest';
import type { DesignerPlan, DesignerProposal } from '@seo/contracts';
import {
  InMemoryAgentRunRepository,
  type NewAgentRun,
} from './agentRunRepository.js';
import type { AgentRunId } from '@seo/contracts';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';

const plan: DesignerPlan = { version: 1, steps: [{ kind: 'designer.review', criteria: ['document_valid'] }] };
const proposal: DesignerProposal = {
  version: 1,
  baseRevision: 'rev1:abc',
  document: { version: 1, blocks: [{ type: 'paragraph' }] },
};

function row(overrides: Partial<NewAgentRun> = {}): NewAgentRun {
  return {
    runId: 'ar_22222222-2222-4222-8222-222222222222',
    accountId: null,
    projectId: PROJECT,
    kind: 'design',
    status: 'queued',
    input: { mode: 'plan', plan, baseRevision: 'rev1:abc' },
    idempotencyKey: null,
    userId: 'user-1',
    ...overrides,
  };
}

describe('InMemoryAgentRunRepository', () => {
  it('inserts and reads back inside the full binding', async () => {
    const repo = new InMemoryAgentRunRepository();
    await repo.insert(row());
    const found = await repo.getBound(row().runId, PROJECT);
    expect(found?.runId).toBe(row().runId);
    expect(found?.status).toBe('queued');
    expect(found?.input.mode).toBe('plan');
    expect(await repo.getBound(row().runId, OTHER_PROJECT)).toBeNull();
  });

  it('resolves an idempotency key per project', async () => {
    const repo = new InMemoryAgentRunRepository();
    await repo.insert(row({ idempotencyKey: 'k1' }));
    expect((await repo.getByProjectAndKey(PROJECT, 'k1'))?.runId).toBe(row().runId);
    expect(await repo.getByProjectAndKey(OTHER_PROJECT, 'k1')).toBeNull();

    await repo.insert(row({ runId: 'ar_33333333-3333-4333-8333-333333333333', projectId: OTHER_PROJECT, idempotencyKey: 'k1' }));
    expect((await repo.getByProjectAndKey(OTHER_PROJECT, 'k1'))?.projectId).toBe(OTHER_PROJECT);
  });

  it('rejects duplicate run ids and duplicate keys within a project', async () => {
    const repo = new InMemoryAgentRunRepository();
    await repo.insert(row({ idempotencyKey: 'k1' }));
    await expect(repo.insert(row())).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      repo.insert(row({ runId: 'ar_44444444-4444-4444-8444-444444444444', idempotencyKey: 'k1' })),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('associates and clears a job id', async () => {
    const repo = new InMemoryAgentRunRepository();
    await repo.insert(row());
    await repo.setJobId(row().runId, PROJECT, 'job-1');
    expect((await repo.getBound(row().runId, PROJECT))?.jobId).toBe('job-1');
    await repo.setJobId(row().runId, PROJECT, null);
    expect((await repo.getBound(row().runId, PROJECT))?.jobId).toBeNull();
  });

  it('applies optimistic transitions and never leaves a terminal state', async () => {
    const repo = new InMemoryAgentRunRepository();
    const runId = row().runId as AgentRunId;
    await repo.insert(row());

    expect(await repo.transition({ runId, projectId: PROJECT, from: ['queued'], to: 'running' })).toBe(true);
    // A second claim attempt from queued must fail because the run moved on.
    expect(await repo.transition({ runId, projectId: PROJECT, from: ['queued'], to: 'running' })).toBe(false);

    const done = await repo.transition({
      runId,
      projectId: PROJECT,
      from: ['running'],
      to: 'succeeded',
      result: proposal,
      completedAt: '2026-01-01T00:00:01.000Z',
    });
    expect(done).toBe(true);
    const stored = await repo.getBound(runId, PROJECT);
    expect(stored?.status).toBe('succeeded');
    expect(stored?.result?.baseRevision).toBe('rev1:abc');
    expect(stored?.completedAt).toBe('2026-01-01T00:00:01.000Z');

    // A duplicate executor cannot corrupt a terminal run.
    expect(await repo.transition({ runId, projectId: PROJECT, from: ['running'], to: 'failed' })).toBe(false);
    expect((await repo.getBound(runId, PROJECT))?.status).toBe('succeeded');
  });
});
