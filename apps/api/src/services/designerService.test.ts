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
