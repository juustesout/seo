/**
 * Composition writer agent tests (Stage 8B).
 *
 * The AI boundary may only return slot fills for the writable slots of the
 * authoritative plan. These tests drive a fake provider so every honest-failure
 * path is covered: missing AI, transport errors, malformed/missing/extra slots
 * (with one bounded corrective retry), and the immutable slot list in the
 * prompt. The module never returns a document, so structure cannot leak.
 */
import { describe, expect, it } from 'vitest';
import type { AIProvider } from '@seo/contracts';
import { MARKETING_STORYBOARD_PLAN, compileComposition } from '@seo/contracts';
import {
  COMPOSITION_WRITE_MAX_ATTEMPTS,
  buildCompositionWriterPrompt,
  createAiCompositionWriter,
} from './writer.js';

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

const COMPILED = compileComposition(MARKETING_STORYBOARD_PLAN);
const INPUT = {
  projectId: 'p1',
  brief: 'Launch a landing page for our analytics tool.',
  plan: MARKETING_STORYBOARD_PLAN,
  slots: COMPILED.slots.slots,
};

function validFills(): Array<{ slot: string; text?: string; items?: string[] }> {
  return COMPILED.slots.slots
    .filter((ref) => ref.type !== 'image' && ref.role !== 'attribution' && ref.role !== 'value')
    .map((ref) => (ref.type === 'list' ? { slot: ref.slot, items: ['One', 'Two'] } : { slot: ref.slot, text: `copy for ${ref.slot}` }));
}

const VALID = JSON.stringify({ slots: validFills() });

describe('composition writer agent', () => {
  it('returns validated fills from valid model JSON', async () => {
    const { provider, calls } = fakeProvider(async () => ({ content: VALID }));
    const writer = createAiCompositionWriter(configuredResolver(provider));
    const outcome = await writer.fill(INPUT);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.fills).toHaveLength(validFills().length);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.json).toBe(true);
  });

  it('accepts fills wrapped in a markdown code fence', async () => {
    const { provider } = fakeProvider(async () => ({ content: '```json\n' + VALID + '\n```' }));
    const outcome = await createAiCompositionWriter(configuredResolver(provider)).fill(INPUT);
    expect(outcome.ok).toBe(true);
  });

  it('retries once when a writable slot is missing, then accepts the correction', async () => {
    const missing = validFills().filter((fill) => fill.slot !== 'problem.body');
    let call = 0;
    const { provider, calls } = fakeProvider(async () => {
      call += 1;
      return { content: call === 1 ? JSON.stringify({ slots: missing }) : VALID };
    });
    const outcome = await createAiCompositionWriter(configuredResolver(provider)).fill(INPUT);
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const secondAttempt = calls[1]!.messages.map((m) => m.content).join('\n');
    expect(secondAttempt).toContain('missing fill');
  });

  it('fails honestly when the model keeps returning invalid output', async () => {
    const { provider, calls } = fakeProvider(async () => ({ content: '{"slots":[]}' }));
    const outcome = await createAiCompositionWriter(configuredResolver(provider)).fill(INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('invalid_output');
    expect(calls).toHaveLength(COMPOSITION_WRITE_MAX_ATTEMPTS);
  });

  it('rejects an extra, non-plan slot', async () => {
    const { provider } = fakeProvider(async () => ({
      content: JSON.stringify({ slots: [...validFills(), { slot: 'ghost.slot', text: 'x' }] }),
    }));
    const outcome = await createAiCompositionWriter(configuredResolver(provider)).fill(INPUT);
    expect(outcome.ok).toBe(false);
  });

  it('reports not_configured without calling the model', async () => {
    const { provider, calls } = fakeProvider(async () => ({ content: VALID }));
    const outcome = await createAiCompositionWriter(async () => ({ provider, configured: false })).fill(INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });

  it('maps a transport failure to ai_error', async () => {
    const { provider } = fakeProvider(async () => {
      throw new Error('upstream 500');
    });
    const outcome = await createAiCompositionWriter(configuredResolver(provider)).fill(INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ai_error');
  });

  it('maps a resolution failure to ai_error', async () => {
    const outcome = await createAiCompositionWriter(async () => {
      throw new Error('credential store unavailable');
    }).fill(INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ai_error');
  });

  it('skips the AI entirely when there are no writable slots', async () => {
    const { provider, calls } = fakeProvider(async () => ({ content: VALID }));
    const outcome = await createAiCompositionWriter(configuredResolver(provider)).fill({
      ...INPUT,
      slots: [{ slot: 'hero.media', type: 'image', id: 'hero__media', path: [0, 0], role: 'media' }],
    });
    expect(outcome).toEqual({ ok: true, fills: [] });
    expect(calls).toHaveLength(0);
  });
});

describe('buildCompositionWriterPrompt', () => {
  it('lists every writable slot and never the unwritable ones', () => {
    const { user } = buildCompositionWriterPrompt(INPUT);
    expect(user).toContain('"hero.title"');
    expect(user).toContain('"feature.card.2.body"');
    expect(user).toContain('"footer.secondaryCta"');
    expect(user).not.toContain('"hero.media"');
    expect(user).not.toContain('"proof.author"');
  });

  it('carries the brief, the immutable-plan rule and the anti-fabrication rule', () => {
    const { system, user } = buildCompositionWriterPrompt(INPUT);
    expect(user).toContain(INPUT.brief);
    expect(user).toContain('IMMUTABLE');
    expect(user).toContain('do NOT add, remove, rename');
    expect(user).toContain('never fabricate statistics');
    expect(system).toContain('authoritative and immutable');
  });

  it('places Cosmos context only inside the untrusted reference block', () => {
    const { user } = buildCompositionWriterPrompt({ ...INPUT, cosmosText: 'Tone: confident, expert.' });
    expect(user).toContain('UNTRUSTED REFERENCE MATERIAL');
    expect(user.indexOf('Tone: confident')).toBeGreaterThan(user.indexOf('UNTRUSTED REFERENCE MATERIAL'));
  });
});
