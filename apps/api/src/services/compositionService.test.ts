/**
 * Composition service tests (Stage 8B).
 *
 * The service owns the production wiring of the full chain: gather bounded
 * Cosmos once, plan through the existing planner service, compile, fill slots
 * through the AI writer boundary and apply them. AIService and Cosmos service
 * are mocked so the assertions stay on wiring and the phase-tagged failure
 * mapping ("Planning failed" / "Writing failed").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../context.js';
import { MARKETING_STORYBOARD_PLAN, compileComposition, isWritableCompositionSlot } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { CompositionService } from './compositionService.js';

const mock = vi.hoisted(() => ({
  chats: [] as Array<{ messages: Array<{ role: string; content: string }> }>,
  responses: [] as string[],
  configured: true,
  providerConfigured: true,
  cosmosCalls: 0,
  cosmosText: '',
  designSystemRef: undefined as { id: string } | undefined,
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

const PLAN_JSON = JSON.stringify(MARKETING_STORYBOARD_PLAN);

function fillsJson(): string {
  const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);
  const slots = compiled.slots.slots
    .filter(isWritableCompositionSlot)
    .map((ref) => (ref.type === 'list' ? { slot: ref.slot, items: ['One'] } : { slot: ref.slot, text: `copy for ${ref.slot}` }));
  return JSON.stringify({ slots });
}

const container = {} as ServiceContainer;
const service = new CompositionService(container);
const INPUT = { brief: 'Launch a landing page for our analytics tool.' };

async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
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
});

describe('CompositionService', () => {
  it('runs planner then writer and returns a filled canonical document', async () => {
    mock.responses = [PLAN_JSON, fillsJson()];
    const result = await service.compose('p1', INPUT);
    expect(result.compositionPlan).toEqual(MARKETING_STORYBOARD_PLAN);
    expect(mock.chats).toHaveLength(2);
    expect(mock.cosmosCalls).toBe(1);

    const hero = result.canonicalDocument.blocks[0]!.children!.find((block) => block.id === 'hero__title');
    expect(hero?.content).toEqual([{ type: 'text', text: 'copy for hero.title' }]);
    const media = result.canonicalDocument.blocks[0]!.children!.find((block) => block.id === 'hero__media');
    expect(media?.content).toBeUndefined();
  });

  it('skips planning when a validated plan is supplied', async () => {
    mock.responses = [fillsJson()];
    const result = await service.compose('p1', { ...INPUT, plan: MARKETING_STORYBOARD_PLAN });
    expect(result.compositionPlan).toEqual(MARKETING_STORYBOARD_PLAN);
    expect(mock.chats).toHaveLength(1);
  });

  it('rejects an invalid supplied plan without calling the model', async () => {
    const err = await expectApiError(
      service.compose('p1', {
        ...INPUT,
        plan: { version: 1, purpose: 'x', format: 'landing_page', sections: [] } as never,
      }),
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe('bad_request');
    expect(mock.chats).toHaveLength(0);
  });

  it('tags a planning failure with the planning phase', async () => {
    mock.responses = ['{"version":1,"purpose":"x","format":"landing_page","sections":[{"type":"nope"}]}', 'still bad'];
    const err = await expectApiError(service.compose('p1', INPUT));
    expect(err.status).toBe(422);
    expect(err.code).toBe('invalid_output');
    expect(err.message).toMatch(/^Planning failed:/);
    expect(err.details).toMatchObject({ phase: 'planning' });
  });

  it('tags a writer failure with the writing phase, never planning', async () => {
    mock.responses = [PLAN_JSON, '{"slots":[]}', '{"slots":[]}'];
    const err = await expectApiError(service.compose('p1', INPUT));
    expect(err.status).toBe(422);
    expect(err.code).toBe('invalid_output');
    expect(err.message).toMatch(/^Writing failed:/);
    expect(err.details).toMatchObject({ phase: 'writing' });
  });

  it('maps an unconfigured project AI on the planning phase to 503 not_configured', async () => {
    mock.configured = false;
    const err = await expectApiError(service.compose('p1', INPUT));
    expect(err.status).toBe(503);
    expect(err.code).toBe('not_configured');
    expect(err.message).toMatch(/^Planning failed:/);
    expect(mock.chats).toHaveLength(0);
  });

  it('passes bounded Cosmos context into the writer prompt', async () => {
    mock.responses = [PLAN_JSON, fillsJson()];
    mock.cosmosText = 'Tone: confident, expert.';
    await service.compose('p1', INPUT);
    const writerUser = mock.chats[1]!.messages.map((m) => m.content).join('\n');
    expect(writerUser).toContain('Tone: confident, expert.');
  });

  it('records the project design-system reference on the canonical document', async () => {
    mock.responses = [PLAN_JSON, fillsJson()];
    mock.designSystemRef = { id: 'cosmos' };
    const result = await service.compose('p1', INPUT);
    expect(result.canonicalDocument.meta?.designSystem).toEqual({ id: 'cosmos' });
  });

  it('leaves the document without a reference when the project has no design tokens', async () => {
    mock.responses = [PLAN_JSON, fillsJson()];
    const result = await service.compose('p1', INPUT);
    expect(result.canonicalDocument.meta?.designSystem).toBeUndefined();
  });
});
