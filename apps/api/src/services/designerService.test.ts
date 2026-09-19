/**
 * Designer service tests (Stage 8E.6, Phase 2).
 *
 * The service owns production wiring: Cosmos once, plan through the existing
 * planner service, slot-fill through the existing Writer boundary, deterministic
 * review, then a baseRevision-guarded proposal. AI, Cosmos and ContentService are
 * mocked so the assertions stay on wiring, the honest freeText seam and the
 * stale-proposal guard (which must not mutate).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../context.js';
import {
  MARKETING_STORYBOARD_PLAN,
  compileComposition,
  contentRevisionOf,
  isWritableCompositionSlot,
} from '@seo/contracts';
import type { DesignerIntent, DesignerPlan, DesignerPlanner } from '@seo/contracts';
import { DesignerService } from './designerService.js';

const mock = vi.hoisted(() => ({
  chats: [] as Array<{ messages: Array<{ role: string; content: string }> }>,
  responses: [] as string[],
  configured: true,
  providerConfigured: true,
  cosmosCalls: 0,
  cosmosText: '',
  contentJson: null as unknown,
  updates: [] as unknown[],
  getCalls: 0,
  provider: {
    id: 'openai',
    isConfigured: () => true,
    chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
      mock.chats.push(req);
      return { content: mock.responses.shift() ?? '' };
    },
    models: () => [],
    capabilities: [] as string[],
  },
}));

vi.mock('./aiService.js', () => ({
  AIService: class {
    async resolve() {
      return {
        provider: { ...mock.provider, isConfigured: () => mock.providerConfigured },
        configured: mock.configured,
        keySource: 'project' as const,
      };
    }
  },
}));

vi.mock('./cosmosService.js', () => ({
  getCosmosContext: async () => {
    mock.cosmosCalls += 1;
    return { text: mock.cosmosText, hasContent: mock.cosmosText.length > 0, useProjectKnowledge: false };
  },
}));

vi.mock('./contentService.js', () => ({
  ContentService: class {
    async get() {
      mock.getCalls += 1;
      return { id: 'c1', content_json: mock.contentJson };
    }
    async update(_projectId: string, _userId: string, _id: string, input: unknown) {
      mock.updates.push(input);
      return { id: 'c1', updated: true };
    }
  },
}));

const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);
const PLAN_JSON = JSON.stringify(MARKETING_STORYBOARD_PLAN);

function fullFills() {
  const slots = compiled.slots.slots
    .filter(isWritableCompositionSlot)
    .map((ref) => (ref.type === 'list' ? { slot: ref.slot, items: ['One'] } : { slot: ref.slot, text: `copy for ${ref.slot}` }));
  return JSON.stringify({ slots });
}

const PLAN = {
  version: 1 as const,
  steps: [
    { kind: 'composer.structure' as const, task: { format: 'landing_page' as const } },
    { kind: 'writer.fillSlots' as const, task: { slots: [] } },
    {
      kind: 'designer.review' as const,
      criteria: ['document_valid' as const, 'structure_preserved' as const, 'slots_filled' as const, 'seo' as const],
    },
  ],
};

const container = {} as ServiceContainer;
const service = new DesignerService(container);

async function expectApiError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status: number; code: string };
  }
  throw new Error('Expected the service to throw');
}

beforeEach(() => {
  mock.chats = [];
  mock.responses = [];
  mock.configured = true;
  mock.providerConfigured = true;
  mock.cosmosCalls = 0;
  mock.cosmosText = '';
  mock.contentJson = null;
  mock.updates = [];
  mock.getCalls = 0;
});

describe('DesignerService.execute', () => {
  it('runs the plan and returns a baseRevision-guarded proposal', async () => {
    mock.responses = [PLAN_JSON, fullFills()];
    const proposal = await service.execute('p1', { plan: PLAN, baseRevision: 'rev1:abc' });
    expect(proposal.baseRevision).toBe('rev1:abc');
    expect(proposal.review?.ok).toBe(true);
    expect(mock.chats).toHaveLength(2);
    expect(mock.cosmosCalls).toBe(1);
    expect(proposal.document.blocks.length).toBeGreaterThan(0);
  });

  it('resolves the baseRevision from the bound content when a contentId is given', async () => {
    mock.contentJson = { type: 'doc', content: [{ type: 'paragraph' }] };
    mock.responses = [PLAN_JSON, fullFills()];
    const proposal = await service.execute('p1', { plan: PLAN, contentId: 'c1' });
    expect(proposal.baseRevision).toBe(contentRevisionOf(mock.contentJson));
    expect(mock.getCalls).toBe(1);
  });

  it('requires a contentId or baseRevision without calling any model', async () => {
    const err = await expectApiError(service.execute('p1', { plan: PLAN }));
    expect(err.status).toBe(400);
    expect(mock.chats).toHaveLength(0);
  });

  it('rejects a writer.fillSlots step that names an unknown slot', async () => {
    mock.responses = [PLAN_JSON];
    const plan = {
      version: 1 as const,
      steps: [
        { kind: 'composer.structure' as const, task: { format: 'landing_page' as const } },
        { kind: 'writer.fillSlots' as const, task: { slots: ['nope.slot'] } },
      ],
    };
    const err = await expectApiError(service.execute('p1', { plan, baseRevision: 'rev1:abc' }));
    expect(err.status).toBe(400);
    expect(mock.chats).toHaveLength(1);
  });

  it('reports writer.freeText as unavailable without calling any model', async () => {
    const plan = {
      version: 1 as const,
      steps: [{ kind: 'writer.freeText' as const, task: { instruction: 'Write a value proposition.' } }],
    };
    const err = await expectApiError(service.execute('p1', { plan, baseRevision: 'rev1:abc' }));
    expect(err.status).toBe(503);
    expect(err.code).toBe('writer_free_text_unavailable');
    expect(mock.chats).toHaveLength(0);
  });

  it('revises stored content through the AI revision Writer and never persists', async () => {
    mock.contentJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old intro' }] }] };
    mock.responses = [JSON.stringify({ revisions: [{ ref: 'b0', text: 'New intro' }] })];
    const plan = {
      version: 1 as const,
      steps: [
        { kind: 'writer.revise' as const, task: { instruction: 'Tighten it.', target: { kind: 'document' as const } } },
        { kind: 'designer.review' as const, criteria: ['document_valid' as const, 'structure_preserved' as const] },
      ],
    };
    const proposal = await service.execute('p1', { plan, contentId: 'c1' });
    expect(proposal.baseRevision).toBe(contentRevisionOf(mock.contentJson));
    expect(proposal.document.blocks[0]?.content).toEqual([{ type: 'text', text: 'New intro' }]);
    expect(proposal.review?.ok).toBe(true);
    expect(mock.chats).toHaveLength(1);
    expect(mock.cosmosCalls).toBe(1);
    expect(mock.updates).toHaveLength(0);
  });

  it('fails a revision target that resolves to no writable block without calling any model', async () => {
    mock.contentJson = { type: 'doc', content: [{ type: 'paragraph' }] };
    const plan = {
      version: 1 as const,
      steps: [
        {
          kind: 'writer.revise' as const,
          task: { instruction: 'Tighten it.', target: { kind: 'block' as const, ref: 'does_not_exist' } },
        },
      ],
    };
    const err = await expectApiError(service.execute('p1', { plan, contentId: 'c1' }));
    expect(err.status).toBe(422);
    expect(err.code).toBe('designer_revision_invalid_target');
    expect(mock.chats).toHaveLength(0);
  });

  it('reports an unconfigured revision Writer honestly', async () => {
    mock.contentJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old' }] }] };
    mock.configured = false;
    const plan = {
      version: 1 as const,
      steps: [
        { kind: 'writer.revise' as const, task: { instruction: 'Tighten it.', target: { kind: 'document' as const } } },
      ],
    };
    const err = await expectApiError(service.execute('p1', { plan, contentId: 'c1' }));
    expect(err.status).toBe(503);
    expect(err.code).toBe('not_configured');
    expect(mock.chats).toHaveLength(0);
  });
});

const PID = '11111111-1111-4111-8111-111111111111';

function intent(overrides: Partial<DesignerIntent> = {}): DesignerIntent {
  return { instruction: 'Create a landing page', projectId: PID, ...overrides };
}

function spyPlanner(plan: DesignerPlan | (() => Promise<DesignerPlan>)): DesignerPlanner & { calls: DesignerIntent[] } {
  const calls: DesignerIntent[] = [];
  return {
    calls,
    async plan(intentValue: DesignerIntent) {
      calls.push(intentValue);
      return typeof plan === 'function' ? plan() : plan;
    },
  };
}

describe('DesignerService.executeIntent', () => {
  it('plans with the deterministic planner then produces a proposal', async () => {
    mock.responses = [PLAN_JSON, fullFills()];
    const proposal = await service.executeIntent(PID, intent(), { baseRevision: 'rev1:abc' });
    expect(proposal.baseRevision).toBe('rev1:abc');
    expect(proposal.plan?.steps[0]).toEqual({ kind: 'composer.structure', task: { format: 'landing_page' } });
    expect(proposal.review?.ok).toBe(true);
    expect(proposal.document.blocks.length).toBeGreaterThan(0);
  });

  it('uses an injected planner behind the same seam', async () => {
    mock.responses = [PLAN_JSON, fullFills()];
    const planner = spyPlanner(PLAN);
    const scoped = new DesignerService(container, { planner });
    const proposal = await scoped.executeIntent(PID, intent(), { baseRevision: 'rev1:abc' });
    expect(planner.calls).toHaveLength(1);
    expect(proposal.review?.ok).toBe(true);
  });

  it('wires the LLM planner when llmPlanner is enabled', async () => {
    mock.responses = [JSON.stringify(PLAN), PLAN_JSON, fullFills()];
    const scoped = new DesignerService(container, { llmPlanner: true });
    const proposal = await scoped.executeIntent(PID, intent(), { baseRevision: 'rev1:abc' });
    expect(proposal.review?.ok).toBe(true);
    expect(mock.chats).toHaveLength(3);
    expect(mock.chats[0]!.messages[0]!.content).toContain('JSON');
  });

  it('rejects an intent that is not scoped to the target project before planning', async () => {
    const planner = spyPlanner(PLAN);
    const scoped = new DesignerService(container, { planner });
    const err = await expectApiError(scoped.executeIntent(PID, intent({ projectId: '22222222-2222-4222-8222-222222222222' })));
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_designer_intent');
    expect(planner.calls).toHaveLength(0);
    expect(mock.chats).toHaveLength(0);
  });

  it('fails closed on invalid planner output without executing', async () => {
    const scoped = new DesignerService(container, { planner: spyPlanner({ version: 1 } as never) });
    const err = await expectApiError(scoped.executeIntent(PID, intent(), { baseRevision: 'rev1:abc' }));
    expect(err.status).toBe(422);
    expect(err.code).toBe('designer_planner_invalid_output');
    expect(mock.chats).toHaveLength(0);
  });

  it('reports a planner failure without executing', async () => {
    const scoped = new DesignerService(container, {
      planner: spyPlanner(() => Promise.reject(new Error('upstream exploded'))),
    });
    const err = await expectApiError(scoped.executeIntent(PID, intent(), { baseRevision: 'rev1:abc' }));
    expect(err.status).toBe(502);
    expect(err.code).toBe('designer_planner_failed');
    expect(mock.chats).toHaveLength(0);
  });

  it('fails explicitly when the deterministic planner cannot recognize the instruction', async () => {
    const err = await expectApiError(service.executeIntent(PID, intent({ instruction: 'Make it pop' }), { baseRevision: 'rev1:abc' }));
    expect(err.status).toBe(422);
    expect(err.code).toBe('designer_planner_unrecognized_intent');
    expect(mock.chats).toHaveLength(0);
  });

  it('never persists: a proposal is not an apply', async () => {
    mock.contentJson = { type: 'doc', content: [{ type: 'paragraph' }] };
    mock.responses = [PLAN_JSON, fullFills()];
    await service.executeIntent(PID, intent({ contentId: '33333333-3333-4333-8333-333333333333' }));
    expect(mock.getCalls).toBe(1);
    expect(mock.updates).toHaveLength(0);
  });
});

describe('DesignerService.apply', () => {
  it('applies a proposal when the content revision still matches', async () => {
    mock.contentJson = { type: 'doc', content: [{ type: 'paragraph' }] };
    const proposal = { version: 1, baseRevision: contentRevisionOf(mock.contentJson), document: compiled.document };
    const row = await service.apply('p1', 'c1', proposal, 'u1');
    expect(row).toMatchObject({ id: 'c1' });
    expect(mock.updates).toHaveLength(1);
  });

  it('rejects a stale proposal with zero mutation', async () => {
    mock.contentJson = { type: 'doc', content: [{ type: 'paragraph' }] };
    const proposal = { version: 1, baseRevision: contentRevisionOf({ other: true }), document: compiled.document };
    const err = await expectApiError(service.apply('p1', 'c1', proposal, 'u1'));
    expect(err.status).toBe(409);
    expect(err.code).toBe('stale_proposal');
    expect(mock.updates).toHaveLength(0);
  });

  it('rejects an invalid proposal before reading content', async () => {
    const err = await expectApiError(service.apply('p1', 'c1', { version: 1 }, 'u1'));
    expect(err.status).toBe(400);
    expect(mock.getCalls).toBe(0);
    expect(mock.updates).toHaveLength(0);
  });
});
