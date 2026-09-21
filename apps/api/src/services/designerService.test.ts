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
  canonicalDocumentToEditorDocument,
  compileComposition,
  contentRevisionOf,
  isValidDesignerProposal,
  isWritableCompositionSlot,
} from '@seo/contracts';
import type {
  CanonicalDocument,
  DesignerIntent,
  DesignerPlan,
  DesignerPlanner,
  ImageInsertionContext,
  VisualDesignOperation,
} from '@seo/contracts';
import { DesignerService } from './designerService.js';

const mock = vi.hoisted(() => ({
  chats: [] as Array<{ messages: Array<{ role: string; content: string }> }>,
  responses: [] as string[],
  configured: true,
  providerConfigured: true,
  cosmosCalls: 0,
  cosmosText: '',
  designSystemRef: undefined as { id: string } | undefined,
  contentJson: null as unknown,
  updates: [] as unknown[],
  getCalls: 0,
  media: [] as Array<{
    id: string;
    filename: string;
    mime_type: string;
    url: string;
    alt_text: string;
    caption: string;
    width: number | null;
    height: number | null;
    usage_count: number;
  }>,
  mediaListCalls: [] as string[],
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
    return {
      text: mock.cosmosText,
      hasContent: mock.cosmosText.length > 0,
      useProjectKnowledge: false,
      ...(mock.designSystemRef ? { designSystemRef: mock.designSystemRef } : {}),
    };
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

vi.mock('./mediaService.js', () => ({
  MediaService: class {
    async list(projectId: string) {
      mock.mediaListCalls.push(projectId);
      return mock.media;
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
  mock.designSystemRef = undefined;
  mock.contentJson = null;
  mock.updates = [];
  mock.getCalls = 0;
  mock.media = [];
  mock.mediaListCalls = [];
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

  it('records the project design-system reference on the proposal document', async () => {
    mock.responses = [PLAN_JSON, fullFills()];
    mock.designSystemRef = { id: 'cosmos' };
    const proposal = await service.execute('p1', { plan: PLAN, baseRevision: 'rev1:abc' });
    expect(proposal.document.meta?.designSystem).toEqual({ id: 'cosmos' });
  });

  it('leaves the proposal without a reference when the project has no design tokens', async () => {
    mock.responses = [PLAN_JSON, fullFills()];
    const proposal = await service.execute('p1', { plan: PLAN, baseRevision: 'rev1:abc' });
    expect(proposal.document.meta?.designSystem).toBeUndefined();
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

describe('DesignerService editor-native image insertion (R3.1)', () => {
  const canonical: CanonicalDocument = {
    version: 1,
    blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Solar panels store energy.' }] }],
  };
  const editorDocument = canonicalDocumentToEditorDocument(canonical);

  function imageContext(revision: string): ImageInsertionContext {
    return {
      revision,
      document: canonical,
      target: { kind: 'cursor', position: 3 },
      nearbyText: 'We install solar panels on residential roofs.',
    };
  }

  it('routes an editor-context intent to image insertion without invoking the planner', async () => {
    mock.contentJson = editorDocument;
    mock.media = [
      {
        id: 'm_solar',
        filename: 'solar-panels.png',
        mime_type: 'image/png',
        url: 'https://cdn.test/solar-panels.png',
        alt_text: 'Solar panels on a roof',
        caption: '',
        width: 1600,
        height: 900,
        usage_count: 0,
      },
    ];
    const proposal = await service.executeIntent(
      PID,
      intent({
        instruction: 'Zet hier een passende afbeelding.',
        contentId: '33333333-3333-4333-8333-333333333333',
        context: { selection: imageContext(contentRevisionOf(editorDocument)) },
      }),
    );
    expect(proposal.insertion?.type).toBe('insert_image');
    expect(proposal.insertion?.image.assetId).toBe('m_solar');
    expect(proposal.baseRevision).toBe(contentRevisionOf(editorDocument));
    expect(mock.chats).toHaveLength(0);
    expect(mock.updates).toHaveLength(0);
  });

  it('refuses to apply a proposal that carries an editor insertion', async () => {
    const insertion = {
      type: 'insert_image' as const,
      target: { kind: 'cursor' as const, position: 0 },
      image: { assetId: 'm_solar', url: 'https://cdn.test/a.png', alt: 'Solar' },
    };
    const proposal = {
      version: 1,
      baseRevision: contentRevisionOf({ other: true }),
      document: compiled.document,
      insertion,
    };
    const err = await expectApiError(service.apply('p1', 'c1', proposal, 'u1'));
    expect(err.status).toBe(422);
    expect(err.code).toBe('designer_insertion_requires_editor');
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

describe('DesignerService visual domain (ADR 5.3)', () => {
  const imageDoc = { version: 1 as const, blocks: [{ id: 'hero__media', type: 'image' }] };
  const selectAsset = { op: 'select_asset' as const, target: 'hero__media', mediaId: 'm1' };
  const asset = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    filename: `${id}.png`,
    mime_type: 'image/png',
    url: `https://cdn.example.com/${id}.png`,
    alt_text: 'Hero',
    caption: '',
    width: 1200,
    height: 800,
    usage_count: 0,
    ...overrides,
  });
  const plan = (operations: VisualDesignOperation[]) => ({
    version: 1 as const,
    steps: [{ kind: 'visual.apply' as const, task: { operations } }],
  });
  const selectPlan = (select: Record<string, unknown>) => ({
    version: 1 as const,
    steps: [{ kind: 'visual.apply' as const, task: { select } }],
  });
  const selectionDoc: CanonicalDocument = {
    version: 1 as const,
    meta: { title: 'Power your property' },
    blocks: [
      {
        id: 'hero',
        type: 'hero',
        children: [
          {
            id: 'hero__title',
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Affordable solar energy' }],
          },
          { id: 'hero__media', type: 'image' },
        ],
      },
      {
        id: 'features',
        type: 'section',
        children: [
          {
            id: 'feat__title',
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Battery storage' }],
          },
          { id: 'feat__media', type: 'image' },
        ],
      },
    ],
  };
  const solar = asset('m_solar', {
    filename: 'solar-panels.png',
    alt_text: 'Solar panels on a roof',
    caption: 'Clean energy',
    width: 1600,
    height: 900,
  });
  const battery = asset('m_battery', {
    filename: 'home-battery.jpg',
    mime_type: 'image/jpeg',
    alt_text: 'Home battery storage unit',
  });

  it('composes resolved media metadata into the proposal and never persists', async () => {
    mock.media = [asset('m1')];
    const proposal = await service.execute('p1', {
      plan: plan([selectAsset]),
      baseRevision: 'rev1:abc',
      baseDocument: imageDoc,
    });
    expect(proposal.baseRevision).toBe('rev1:abc');
    expect(proposal.document.blocks[0]?.attrs).toEqual({
      mediaId: 'm1',
      src: 'https://cdn.example.com/m1.png',
      alt: 'Hero',
      caption: '',
      width: 1200,
      height: 800,
    });
    expect(mock.mediaListCalls).toEqual(['p1']);
    expect(mock.updates).toHaveLength(0);
  });

  it('fails honestly when a referenced asset is not in the project library', async () => {
    mock.media = [];
    const err = await expectApiError(
      service.execute('p1', { plan: plan([selectAsset]), baseRevision: 'rev1:abc', baseDocument: imageDoc }),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('visual_design_unknown_asset');
    expect(mock.updates).toHaveLength(0);
  });

  it('fails when a visual target does not resolve to a block', async () => {
    mock.media = [asset('m1')];
    const err = await expectApiError(
      service.execute('p1', {
        plan: plan([{ op: 'select_asset', target: 'missing', mediaId: 'm1' }]),
        baseRevision: 'rev1:abc',
        baseDocument: imageDoc,
      }),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('visual_design_unknown_target');
  });

  it('refuses to assign an asset to a non-image block', async () => {
    mock.media = [asset('m1')];
    const err = await expectApiError(
      service.execute('p1', {
        plan: plan([{ op: 'select_asset', target: 'hero', mediaId: 'm1' }]),
        baseRevision: 'rev1:abc',
        baseDocument: { version: 1 as const, blocks: [{ id: 'hero', type: 'section' }] },
      }),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('visual_design_unsupported_target');
  });

  it('fails conflicting duplicate operations instead of silently overwriting', async () => {
    mock.media = [asset('m1'), asset('m2')];
    const err = await expectApiError(
      service.execute('p1', {
        plan: plan([selectAsset, { op: 'select_asset', target: 'hero__media', mediaId: 'm2' }]),
        baseRevision: 'rev1:abc',
        baseDocument: imageDoc,
      }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe('visual_design_duplicate_operation');
    expect(mock.updates).toHaveLength(0);
  });

  it('selects the best matching project asset for each image block and never persists', async () => {
    mock.media = [solar, battery];
    const proposal = await service.execute('p1', {
      plan: selectPlan({}),
      baseRevision: 'rev1:abc',
      baseDocument: selectionDoc,
    });
    expect(proposal.document.blocks[0]?.children?.[1]?.attrs?.mediaId).toBe('m_solar');
    expect(proposal.document.blocks[1]?.children?.[1]?.attrs?.mediaId).toBe('m_battery');
    expect(proposal.baseRevision).toBe('rev1:abc');
    // Retrieval is project-scoped: only this project's media list was read.
    expect(mock.mediaListCalls).toEqual(['p1']);
    expect(mock.updates).toHaveLength(0);
  });

  it('selects an asset only from the project-scoped media list it was given', async () => {
    mock.media = [solar];
    const proposal = await service.execute('p1', {
      plan: selectPlan({ targets: ['hero__media'] }),
      baseRevision: 'rev1:abc',
      baseDocument: selectionDoc,
    });
    expect(proposal.document.blocks[0]?.children?.[1]?.attrs?.mediaId).toBe('m_solar');
    expect(mock.mediaListCalls).toEqual(['p1']);
    expect(mock.updates).toHaveLength(0);
  });

  it('fails explicitly with no suitable asset when nothing matches', async () => {
    mock.media = [asset('m_cat', { filename: 'cat.png', alt_text: 'A cat' })];
    const err = await expectApiError(
      service.execute('p1', { plan: selectPlan({}), baseRevision: 'rev1:abc', baseDocument: selectionDoc }),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('visual_no_suitable_asset');
    expect((err as { details?: { unmatched?: unknown[] } }).details?.unmatched).toHaveLength(2);
    expect(mock.updates).toHaveLength(0);
  });

  it('fails an explicit target list that cannot be satisfied instead of guessing', async () => {
    mock.media = [solar];
    const err = await expectApiError(
      service.execute('p1', {
        plan: selectPlan({ targets: ['feat__media'] }),
        baseRevision: 'rev1:abc',
        baseDocument: selectionDoc,
      }),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('visual_no_suitable_asset');
    expect(mock.updates).toHaveLength(0);
  });

  it('keeps the visual rationale and unmatched targets as proposal provenance only', async () => {
    // Only one asset exists: the hero block matches, the feature block does not.
    mock.media = [solar];
    const proposal = await service.execute('p1', {
      plan: selectPlan({}),
      baseRevision: 'rev1:abc',
      baseDocument: selectionDoc,
    });
    expect(proposal.visual?.operations).toEqual([{ op: 'select_asset', target: 'hero__media', mediaId: 'm_solar' }]);
    expect(proposal.visual?.rationale?.[0]).toMatch(/solar/i);
    expect(proposal.visual?.unmatched).toEqual([{ targetBlockId: 'feat__media', reason: 'all_conflicting' }]);
    // Provenance never changes the document or the proposal's validity.
    expect(isValidDesignerProposal(proposal)).toBe(true);
    expect(mock.updates).toHaveLength(0);
  });

  it('reaches the existing review/apply path without any direct persistence', async () => {
    mock.contentJson = { type: 'doc', content: [{ type: 'paragraph' }] };
    mock.media = [solar, battery];
    const proposal = await service.execute('p1', {
      plan: selectPlan({}),
      contentId: 'c1',
      baseDocument: selectionDoc,
    });
    expect(proposal.baseRevision).toBe(contentRevisionOf(mock.contentJson));
    expect(mock.updates).toHaveLength(0);

    const row = await service.apply('p1', 'c1', proposal, 'u1');
    expect(row).toMatchObject({ id: 'c1' });
    expect(mock.updates).toHaveLength(1);
  });
});
