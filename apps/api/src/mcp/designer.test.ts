/**
 * MCP Designer tool tests (ADR Phase 5.4).
 *
 * The Designer tools are a thin adapter over AgentRunService + DesignerService:
 * execute shapes the existing durable-run submission, get_run reads the
 * project-scoped run, and apply forwards a validated proposal to the existing
 * revision-guarded apply. These tests assert that delegation, that the proposal
 * (document, plan, review, visual provenance) survives the MCP boundary, and
 * that no MCP-specific execution, mutation or authorization path exists. The
 * services are spied, so no planner, provider or database ever runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTools } from './server.js';
import type { MpcDeps } from './server.js';
import { AgentRunService } from '../services/agentRunService.js';
import { DesignerService } from '../services/designerService.js';
import { ContentService } from '../services/contentService.js';
import { ApiError } from '../apiErrors.js';
import { MARKETING_STORYBOARD_PLAN, compileComposition } from '@seo/contracts';
import type { AgentRun, DesignerPlan, DesignerProposal, VisualDesignProposal } from '@seo/contracts';

const PROJECT = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT = '55555555-5555-4555-8555-555555555555';
const CONTENT = '11111111-1111-4111-8111-111111111111';
const RUN_ID = 'ar_33333333-3333-4333-8333-333333333333';

const byName = (name: string) => buildTools().find((t) => t.name === name)!;

function deps(overrides: Partial<MpcDeps> = {}): MpcDeps {
  return {
    sb: {} as never,
    jobStore: {} as never,
    scope: 'project',
    projectId: PROJECT,
    userId: 'u1',
    canRead: true,
    canWrite: true,
    ...overrides,
  } as MpcDeps;
}

const editor = () => deps();
const viewer = () => deps({ canWrite: false });

async function expectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ApiError with code '${code}'`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
  }
}

async function expectsStatus(promise: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await promise;
    throw new Error(`expected ApiError with status ${status}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    return err as ApiError;
  }
}

const DESIGN_PLAN: DesignerPlan = {
  version: 1,
  steps: [{ kind: 'designer.review', criteria: ['document_valid'] }],
};

const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);

const VISUAL: VisualDesignProposal = {
  kind: 'visual_design_proposal',
  version: 1,
  operations: [],
  rationale: ['hero: matched hero-related metadata'],
  unmatched: [{ targetBlockId: 'feat', reason: 'below_threshold' }],
};

function proposal(overrides: Partial<DesignerProposal> = {}): DesignerProposal {
  return {
    version: 1,
    baseRevision: 'rev1:abc',
    document: compiled.document,
    plan: DESIGN_PLAN,
    review: { ok: true, errors: [], warnings: [] },
    ...overrides,
  };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: RUN_ID,
    kind: 'design',
    projectId: PROJECT,
    status: 'succeeded',
    input: { mode: 'intent', intent: { instruction: 'Improve the hero', projectId: PROJECT } },
    result: proposal(),
    error: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z',
    completedAt: '2026-09-01T00:00:01.000Z',
    ...overrides,
  };
}

const resultOf = (data: Record<string, unknown>): DesignerProposal =>
  (data as { result: DesignerProposal }).result;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mcp designer discovery', () => {
  it('exposes a compact, proposal-first capability description', async () => {
    const tool = byName('designer_capabilities');
    expect(tool.readOnly).toBe(true);

    const out = await tool.handler(viewer(), {});
    expect(out.data).toMatchObject({
      capability: 'designer',
      proposal_first: true,
      apply_required: true,
      asynchronous: true,
      tools: { execute: 'designer_execute', inspect: 'designer_get_run', apply: 'designer_apply' },
    });
    expect(out.data).toMatchObject({ domains: expect.arrayContaining(['visual']) });
  });

  it('marks execute and apply as writes, capabilities and get_run as reads', () => {
    expect(byName('designer_execute').readOnly).toBe(false);
    expect(byName('designer_apply').readOnly).toBe(false);
    expect(byName('designer_get_run').readOnly).toBe(true);
  });

  it('describes apply as separate from execute', () => {
    expect(byName('designer_execute').description).toContain('never applies changes');
    expect(byName('designer_apply').description).toContain('Explicitly apply');
  });
});

describe('mcp designer execute delegates to the durable run service', () => {
  it('executes a create intent with base_revision and returns the queued run', async () => {
    const submit = vi
      .spyOn(AgentRunService.prototype, 'submitDesignRun')
      .mockResolvedValue({ run: run({ status: 'queued', result: null, completedAt: null }), reused: false });

    const out = await byName('designer_execute').handler(editor(), {
      mode: 'intent',
      instruction: 'Create a landing page for a local accounting firm',
      base_revision: 'rev1:create',
    });

    expect(out.data).toMatchObject({ reused: false, run: { runId: RUN_ID, status: 'queued' } });
    expect(submit).toHaveBeenCalledWith(PROJECT, 'u1', {
      mode: 'intent',
      instruction: 'Create a landing page for a local accounting firm',
      baseRevision: 'rev1:create',
    });
  });

  it('executes an edit intent against a content_id without manufacturing a revision', async () => {
    const get = vi.spyOn(ContentService.prototype, 'get').mockResolvedValue({ id: CONTENT } as never);
    const submit = vi
      .spyOn(AgentRunService.prototype, 'submitDesignRun')
      .mockResolvedValue({ run: run(), reused: false });

    await byName('designer_execute').handler(editor(), {
      mode: 'intent',
      instruction: 'Improve the hero section and clarify the call to action',
      content_id: CONTENT,
    });

    expect(get).toHaveBeenCalledWith(PROJECT, CONTENT);
    expect(submit).toHaveBeenCalledWith(PROJECT, 'u1', {
      mode: 'intent',
      instruction: 'Improve the hero section and clarify the call to action',
      contentId: CONTENT,
    });
  });

  it('executes an explicit plan through the same durable run contract', async () => {
    const submit = vi
      .spyOn(AgentRunService.prototype, 'submitDesignRun')
      .mockResolvedValue({ run: run(), reused: false });

    await byName('designer_execute').handler(editor(), {
      mode: 'plan',
      plan: DESIGN_PLAN,
      base_revision: 'rev1:create',
    });

    expect(submit).toHaveBeenCalledWith(PROJECT, 'u1', {
      mode: 'plan',
      plan: DESIGN_PLAN,
      baseRevision: 'rev1:create',
    });
  });

  it('rejects missing or contradictory inputs before touching the service', async () => {
    const submit = vi.spyOn(AgentRunService.prototype, 'submitDesignRun').mockResolvedValue({ run: run(), reused: false });
    const d = editor();

    await expectsCode(byName('designer_execute').handler(d, { mode: 'intent' }), 'invalid_input');
    await expectsCode(
      byName('designer_execute').handler(d, { mode: 'intent', instruction: 'x', content_id: CONTENT, base_revision: 'rev1:create' }),
      'invalid_input',
    );
    await expectsCode(
      byName('designer_execute').handler(d, { mode: 'intent', instruction: 'x', plan: DESIGN_PLAN, base_revision: 'rev1:create' }),
      'invalid_input',
    );
    await expectsCode(
      byName('designer_execute').handler(d, { mode: 'plan', base_revision: 'rev1:create' }),
      'invalid_input',
    );
    await expectsCode(
      byName('designer_execute').handler(d, { mode: 'plan', plan: { version: 1, steps: [] }, base_revision: 'rev1:create' }),
      'invalid_input',
    );
    await expectsCode(byName('designer_execute').handler(d, { mode: 'nonsense', instruction: 'x', base_revision: 'rev1:create' }), 'invalid_input');
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects a plan that names internal visual identifiers at the contract boundary', async () => {
    const submit = vi.spyOn(AgentRunService.prototype, 'submitDesignRun').mockResolvedValue({ run: run(), reused: false });
    const planWithInventedIds = {
      version: 1,
      steps: [
        {
          kind: 'visual.apply',
          task: { select: { targetBlockIds: ['made-up-id'], assetIds: ['made-up-asset'] } },
        },
      ],
    };

    await expectsCode(
      byName('designer_execute').handler(editor(), { mode: 'plan', plan: planWithInventedIds, base_revision: 'rev1:create' }),
      'invalid_input',
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects a missing content target when content_id is given', async () => {
    vi.spyOn(ContentService.prototype, 'get').mockRejectedValue(new ApiError(404, 'content_not_found', 'Content not found'));
    const submit = vi.spyOn(AgentRunService.prototype, 'submitDesignRun').mockResolvedValue({ run: run(), reused: false });

    await expectsCode(
      byName('designer_execute').handler(editor(), { mode: 'intent', instruction: 'x', content_id: CONTENT }),
      'content_not_found',
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('surfaces execution failures with their existing code', async () => {
    vi.spyOn(AgentRunService.prototype, 'submitDesignRun').mockRejectedValue(
      new ApiError(422, 'designer_planner_invalid_output', 'The planner returned an invalid plan'),
    );
    await expectsCode(
      byName('designer_execute').handler(editor(), { mode: 'intent', instruction: 'x', base_revision: 'rev1:create' }),
      'designer_planner_invalid_output',
    );
  });

  it('refuses to execute without a user identity on the key', async () => {
    vi.spyOn(AgentRunService.prototype, 'submitDesignRun').mockResolvedValue({ run: run(), reused: false });
    await expectsStatus(
      byName('designer_execute').handler(deps({ userId: null }), { mode: 'intent', instruction: 'x', base_revision: 'rev1:create' }),
      403,
    );
  });

  it('does not mutate content: execute never calls apply or content update', async () => {
    vi.spyOn(ContentService.prototype, 'get').mockResolvedValue({ id: CONTENT } as never);
    vi.spyOn(AgentRunService.prototype, 'submitDesignRun').mockResolvedValue({ run: run(), reused: false });
    const apply = vi.spyOn(DesignerService.prototype, 'apply');
    const update = vi.spyOn(ContentService.prototype, 'update');

    await byName('designer_execute').handler(editor(), { mode: 'intent', instruction: 'x', content_id: CONTENT });

    expect(apply).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('mcp designer run inspection is project scoped', () => {
  it('returns a succeeded run with its proposal, plan and review intact', async () => {
    vi.spyOn(AgentRunService.prototype, 'getRun').mockResolvedValue(run());

    const out = await byName('designer_get_run').handler(viewer(), { run_id: RUN_ID });
    const result = resultOf(out.data as Record<string, unknown>);

    expect(out.data).toMatchObject({ runId: RUN_ID, status: 'succeeded' });
    expect(result.baseRevision).toBe('rev1:abc');
    expect(result.document).toEqual(compiled.document);
    expect(result.plan).toEqual(DESIGN_PLAN);
    expect(result.review).toMatchObject({ ok: true });
  });

  it('represents queued and running states without a result', async () => {
    const getRun = vi.spyOn(AgentRunService.prototype, 'getRun');
    getRun.mockResolvedValueOnce(run({ status: 'queued', result: null, completedAt: null }));
    getRun.mockResolvedValueOnce(run({ status: 'running', result: null, completedAt: null }));

    const queued = await byName('designer_get_run').handler(viewer(), { run_id: RUN_ID });
    const running = await byName('designer_get_run').handler(viewer(), { run_id: RUN_ID });

    expect(queued.data).toMatchObject({ status: 'queued', result: null });
    expect(running.data).toMatchObject({ status: 'running', result: null });
  });

  it('exposes structured failure information on a failed run', async () => {
    vi.spyOn(AgentRunService.prototype, 'getRun').mockResolvedValue(
      run({
        status: 'failed',
        result: null,
        completedAt: null,
        error: { code: 'designer_planner_invalid_output', message: 'bad plan', retryable: false },
      }),
    );

    const out = await byName('designer_get_run').handler(viewer(), { run_id: RUN_ID });
    expect(out.data).toMatchObject({ status: 'failed', error: { code: 'designer_planner_invalid_output' } });
  });

  it('preserves visual provenance, including unmatched targets', async () => {
    vi.spyOn(AgentRunService.prototype, 'getRun').mockResolvedValue(run({ result: proposal({ visual: VISUAL }) }));

    const out = await byName('designer_get_run').handler(viewer(), { run_id: RUN_ID });
    const result = resultOf(out.data as Record<string, unknown>);

    expect(result.visual).toEqual(VISUAL);
    expect(result.visual?.unmatched).toEqual([{ targetBlockId: 'feat', reason: 'below_threshold' }]);
  });

  it('reports a cross-project run as not found instead of leaking it', async () => {
    const getRun = vi.spyOn(AgentRunService.prototype, 'getRun').mockResolvedValue(null);

    await expectsStatus(byName('designer_get_run').handler(viewer(), { run_id: RUN_ID }), 404);
    expect(getRun).toHaveBeenCalledWith(PROJECT, RUN_ID);
  });

  it('rejects a malformed run id before hitting the service', async () => {
    const getRun = vi.spyOn(AgentRunService.prototype, 'getRun');
    await expectsCode(byName('designer_get_run').handler(viewer(), { run_id: 'nope' }), 'invalid_input');
    expect(getRun).not.toHaveBeenCalled();
  });
});

describe('mcp designer apply is the only explicit write', () => {
  it('forwards a validated proposal to the existing apply service', async () => {
    const apply = vi.spyOn(DesignerService.prototype, 'apply').mockResolvedValue({ id: CONTENT, updated: true } as never);
    const p = proposal();

    const out = await byName('designer_apply').handler(editor(), { content_id: CONTENT, proposal: p });

    expect(out.data).toMatchObject({ id: CONTENT });
    expect(apply).toHaveBeenCalledWith(PROJECT, CONTENT, p, 'u1');
  });

  it('rejects an invalid proposal before calling the service', async () => {
    const apply = vi.spyOn(DesignerService.prototype, 'apply');
    await expectsCode(byName('designer_apply').handler(editor(), { content_id: CONTENT, proposal: {} }), 'invalid_input');
    expect(apply).not.toHaveBeenCalled();
  });

  it('requires a content_id to apply to', async () => {
    const apply = vi.spyOn(DesignerService.prototype, 'apply');
    await expectsCode(byName('designer_apply').handler(editor(), { proposal: proposal() }), 'invalid_input');
    expect(apply).not.toHaveBeenCalled();
  });

  it('surfaces a stale proposal as the existing 409 conflict', async () => {
    vi.spyOn(DesignerService.prototype, 'apply').mockRejectedValue(
      new ApiError(409, 'stale_proposal', 'The content changed since this proposal was generated; generate it again.'),
    );
    await expectsCode(byName('designer_apply').handler(editor(), { content_id: CONTENT, proposal: proposal() }), 'stale_proposal');
  });

  it('surfaces a wrong content identity instead of applying elsewhere', async () => {
    vi.spyOn(DesignerService.prototype, 'apply').mockRejectedValue(new ApiError(404, 'content_not_found', 'Content not found'));
    await expectsCode(byName('designer_apply').handler(editor(), { content_id: CONTENT, proposal: proposal() }), 'content_not_found');
  });

  it('refuses to apply without editor scope or a user identity', async () => {
    const apply = vi.spyOn(DesignerService.prototype, 'apply');
    await expectsStatus(byName('designer_apply').handler(viewer(), { content_id: CONTENT, proposal: proposal() }), 403);
    await expectsStatus(
      byName('designer_apply').handler(deps({ userId: null }), { content_id: CONTENT, proposal: proposal() }),
      403,
    );
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('mcp designer tools cannot address another project', () => {
  it('rejects a project_id that does not match the bound key', async () => {
    const submit = vi.spyOn(AgentRunService.prototype, 'submitDesignRun');
    const getRun = vi.spyOn(AgentRunService.prototype, 'getRun');
    const apply = vi.spyOn(DesignerService.prototype, 'apply');
    const d = editor();

    await expectsStatus(
      byName('designer_execute').handler(d, { project_id: OTHER_PROJECT, mode: 'intent', instruction: 'x', base_revision: 'rev1:create' }),
      403,
    );
    await expectsStatus(byName('designer_get_run').handler(d, { project_id: OTHER_PROJECT, run_id: RUN_ID }), 403);
    await expectsStatus(
      byName('designer_apply').handler(d, { project_id: OTHER_PROJECT, content_id: CONTENT, proposal: proposal() }),
      403,
    );

    expect(submit).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});
