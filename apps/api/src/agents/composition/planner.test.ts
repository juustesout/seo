/**
 * Composition planner agent tests (Stage 7).
 *
 * The AI boundary must return only a validated `CompositionPlan`. These tests
 * drive a fake provider so every honest-failure path is covered: missing AI,
 * transport errors, malformed JSON (with one bounded corrective retry), and
 * structurally invalid plans (unknown keys, invented vocabulary, bad layout,
 * duplicate slots, CSS injection, excessive nesting).
 */
import { describe, expect, it } from 'vitest';
import type { AIProvider, CompositionPlan } from '@seo/contracts';
import { MARKETING_STORYBOARD_PLAN, isValidCompositionPlan } from '@seo/contracts';
import {
  COMPOSITION_PLAN_MAX_ATTEMPTS,
  buildCompositionPlannerPrompt,
  createAiCompositionPlanner,
} from './planner.js';

interface ChatCall {
  messages: Array<{ role: string; content: string }>;
  json?: boolean;
}

function fakeProvider(chat: (call: ChatCall) => Promise<{ content: string }>): {
  provider: AIProvider;
  calls: ChatCall[];
} {
  const calls: ChatCall[] = [];
  const provider = {
    id: 'openai',
    isConfigured: () => true,
    chat: (req: ChatCall) => {
      calls.push(req);
      return chat(req);
    },
    models: () => [],
    capabilities: [],
  } as unknown as AIProvider;
  return { provider, calls };
}

function configuredResolver(provider: AIProvider) {
  return async () => ({ provider, configured: true });
}

const VALID_PLAN = JSON.stringify(MARKETING_STORYBOARD_PLAN);

describe('composition planner agent', () => {
  it('returns a validated plan from valid model JSON', async () => {
    const { provider, calls } = fakeProvider(async () => ({ content: VALID_PLAN }));
    const planner = createAiCompositionPlanner(configuredResolver(provider));
    const outcome = await planner.plan({ projectId: 'p1', brief: 'Launch a landing page for our analytics tool.' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(isValidCompositionPlan(outcome.plan)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.json).toBe(true);
  });

  it('accepts a plan wrapped in a markdown code fence', async () => {
    const { provider } = fakeProvider(async () => ({ content: '```json\n' + VALID_PLAN + '\n```' }));
    const planner = createAiCompositionPlanner(configuredResolver(provider));
    const outcome = await planner.plan({ projectId: 'p1', brief: 'A brief that is long enough.' });
    expect(outcome.ok).toBe(true);
  });

  it('retries once when the first reply is not JSON, then succeeds', async () => {
    let first = true;
    const { provider, calls } = fakeProvider(async () => {
      if (first) {
        first = false;
        return { content: 'sorry, here is a plan' };
      }
      return { content: VALID_PLAN };
    });
    const planner = createAiCompositionPlanner(configuredResolver(provider));
    const outcome = await planner.plan({ projectId: 'p1', brief: 'A brief that is long enough.' });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages.at(-1)!.content).toContain('not a valid composition plan');
  });

  it('fails with invalid_output after the bounded retry when JSON is never returned', async () => {
    const { provider, calls } = fakeProvider(async () => ({ content: 'not json at all' }));
    const planner = createAiCompositionPlanner(configuredResolver(provider));
    const outcome = await planner.plan({ projectId: 'p1', brief: 'A brief that is long enough.' });
    expect(outcome).toEqual({
      ok: false,
      code: 'invalid_output',
      note: expect.stringContaining('composition plan'),
    });
    expect(calls).toHaveLength(COMPOSITION_PLAN_MAX_ATTEMPTS);
  });

  it('rejects an invented block type', async () => {
    const plan = structuredClone(MARKETING_STORYBOARD_PLAN) as unknown as Record<string, unknown>;
    (plan.sections as Array<Record<string, unknown>>)[0]!.type = 'superBanner';
    await expectInvalid(plan);
  });

  it('rejects an unsupported variant for a block type', async () => {
    const plan = structuredClone(MARKETING_STORYBOARD_PLAN) as unknown as Record<string, unknown>;
    (plan.sections as Array<Record<string, unknown>>)[0]!.variant = 'neon';
    await expectInvalid(plan);
  });

  it('rejects an invalid layout value', async () => {
    const plan = structuredClone(MARKETING_STORYBOARD_PLAN) as unknown as Record<string, unknown>;
    (plan.sections as Array<Record<string, unknown>>)[0]!.layout = { width: 'gigantic' };
    await expectInvalid(plan);
  });

  it('rejects CSS injected through an unknown attribute', async () => {
    const plan = structuredClone(MARKETING_STORYBOARD_PLAN) as unknown as Record<string, unknown>;
    (plan.sections as Array<Record<string, unknown>>)[0]!.style = 'color: red';
    await expectInvalid(plan);
  });

  it('rejects a duplicated slot across the plan', async () => {
    const plan = structuredClone(MARKETING_STORYBOARD_PLAN) as unknown as Record<string, unknown>;
    const sections = plan.sections as Array<Record<string, unknown>>;
    (sections[1]!.requiredContent as Array<Record<string, unknown>>)[0]!.slot = 'hero.title';
    await expectInvalid(plan);
  });

  it('rejects a malformed slot id', async () => {
    const plan = structuredClone(MARKETING_STORYBOARD_PLAN) as unknown as Record<string, unknown>;
    (plan.sections as Array<Record<string, unknown>>)[0]!.requiredContent = [
      { slot: 'Hero Title!', type: 'heading', level: 1 },
    ];
    await expectInvalid(plan);
  });

  it('rejects excessive nesting', async () => {
    let node: Record<string, unknown> = {
      type: 'section',
      requiredContent: [{ slot: 'deep.leaf', type: 'paragraph' }],
    };
    for (let i = 0; i < 20; i += 1) node = { type: 'section', children: [node] };
    const plan = {
      version: 1,
      purpose: 'Deeply nested.',
      format: 'landing_page',
      sections: [node],
    };
    await expectInvalid(plan);
  });

  it('reports not_configured without calling the provider', async () => {
    const { provider, calls } = fakeProvider(async () => ({ content: VALID_PLAN }));
    const planner = createAiCompositionPlanner(async () => ({ provider, configured: false }));
    const outcome = await planner.plan({ projectId: 'p1', brief: 'A brief that is long enough.' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });

  it('reports ai_error when the provider throws', async () => {
    const { provider } = fakeProvider(async () => {
      throw new Error('upstream 500');
    });
    const planner = createAiCompositionPlanner(configuredResolver(provider));
    const outcome = await planner.plan({ projectId: 'p1', brief: 'A brief that is long enough.' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ai_error');
  });

  it('reports ai_error when AI resolution throws', async () => {
    const planner = createAiCompositionPlanner(async () => {
      throw new Error('credential store unavailable');
    });
    const outcome = await planner.plan({ projectId: 'p1', brief: 'A brief that is long enough.' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ai_error');
  });
});

async function expectInvalid(plan: CompositionPlan | Record<string, unknown>): Promise<void> {
  const { provider } = fakeProvider(async () => ({ content: JSON.stringify(plan) }));
  const planner = createAiCompositionPlanner(configuredResolver(provider));
  const outcome = await planner.plan({ projectId: 'p1', brief: 'A brief that is long enough.' });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.code).toBe('invalid_output');
}

describe('composition planner prompt', () => {
  it('bounds the brief and keeps the format explicit', () => {
    const { system, user } = buildCompositionPlannerPrompt({
      projectId: 'p1',
      brief: 'A short brief.',
      format: 'landing_page',
    });
    expect(system).toContain('UNTRUSTED REFERENCE MATERIAL');
    expect(user).toContain('A short brief.');
    expect(user).toContain('format: landing_page');
    expect(user).not.toContain('p1');
  });

  it('places Cosmos text inside the delimited reference block only', () => {
    const { user } = buildCompositionPlannerPrompt({
      projectId: 'p1',
      brief: 'A short brief.',
      cosmosText: 'Tone: confident.',
    });
    const markerIndex = user.indexOf('UNTRUSTED REFERENCE MATERIAL');
    expect(markerIndex).toBeGreaterThan(-1);
    expect(user.indexOf('Tone: confident.')).toBeGreaterThan(markerIndex);
  });
});
