/**
 * Composition planner service tests (Stage 7).
 *
 * The service owns the production wiring: it gathers bounded Cosmos context,
 * resolves the project's AI through the existing AIService gate, and maps
 * planner failures onto the shared ApiError vocabulary. AIService and
 * Cosmos service are mocked so the assertions stay on wiring and mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../context.js';
import { MARKETING_STORYBOARD_PLAN } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { CompositionPlannerService } from './compositionPlannerService.js';

const mock = vi.hoisted(() => ({
  calls: [] as Array<{ messages: Array<{ role: string; content: string }> }>,
  response: '',
  configured: true,
  providerConfigured: true,
  resolveThrows: null as Error | null,
  chatThrows: null as Error | null,
  cosmosText: '',
  provider: {
    id: 'openai',
    isConfigured: () => true,
    chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
      mock.calls.push(req);
      if (mock.chatThrows) throw mock.chatThrows;
      return { content: mock.response };
    },
    models: () => [],
    capabilities: [] as string[],
  },
}));

vi.mock('./aiService.js', () => ({
  AIService: class {
    async resolve() {
      if (mock.resolveThrows) throw mock.resolveThrows;
      return {
        provider: { ...mock.provider, isConfigured: () => mock.providerConfigured },
        configured: mock.configured,
        keySource: 'project' as const,
      };
    }
  },
}));

vi.mock('./cosmosService.js', () => ({
  getCosmosContext: async () => ({
    text: mock.cosmosText,
    hasContent: mock.cosmosText.length > 0,
    useProjectKnowledge: false,
  }),
}));

const container = {} as ServiceContainer;
const service = new CompositionPlannerService(container);
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
  mock.calls = [];
  mock.response = JSON.stringify(MARKETING_STORYBOARD_PLAN);
  mock.configured = true;
  mock.providerConfigured = true;
  mock.resolveThrows = null;
  mock.chatThrows = null;
  mock.cosmosText = '';
});

describe('CompositionPlannerService', () => {
  it('returns the validated plan from the AI response', async () => {
    const plan = await service.plan('p1', INPUT);
    expect(plan).toEqual(MARKETING_STORYBOARD_PLAN);
    expect(mock.calls).toHaveLength(1);
  });

  it('passes bounded Cosmos context into the prompt', async () => {
    mock.cosmosText = 'Tone: confident, expert.';
    await service.plan('p1', INPUT);
    const user = mock.calls[0]!.messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Tone: confident, expert.');
  });

  it('maps an unconfigured project AI to 503 not_configured without calling the model', async () => {
    mock.configured = false;
    const err = await expectApiError(service.plan('p1', INPUT));
    expect(err.status).toBe(503);
    expect(err.code).toBe('not_configured');
    expect(mock.calls).toHaveLength(0);
  });

  it('maps an unconfigured provider to 503 not_configured', async () => {
    mock.providerConfigured = false;
    const err = await expectApiError(service.plan('p1', INPUT));
    expect(err.status).toBe(503);
    expect(err.code).toBe('not_configured');
  });

  it('maps invalid model output to 422 invalid_output', async () => {
    mock.response = '{"version":1,"purpose":"x","format":"landing_page","sections":[{"type":"nope"}]}';
    const err = await expectApiError(service.plan('p1', INPUT));
    expect(err.status).toBe(422);
    expect(err.code).toBe('invalid_output');
  });

  it('maps a provider transport failure to 502 ai_error', async () => {
    mock.chatThrows = new Error('upstream 500');
    const err = await expectApiError(service.plan('p1', INPUT));
    expect(err.status).toBe(502);
    expect(err.code).toBe('ai_error');
  });

  it('maps an AI resolution failure to 502 ai_error', async () => {
    mock.resolveThrows = new Error('credential store unavailable');
    const err = await expectApiError(service.plan('p1', INPUT));
    expect(err.status).toBe(502);
    expect(err.code).toBe('ai_error');
  });
});
