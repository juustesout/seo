/**
 * R5.10.3 usage instrumentation tests.
 *
 * Pins that AI provider operations become append-only usage events through the
 * single resolved-provider seam, that no events are fabricated when usage is
 * absent or the provider was never reached, and that usage persistence can
 * never break the underlying AI operation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider } from '@seo/contracts';
import type { ServiceContainer } from '../context.js';
import { AIService } from './aiService.js';
import { InMemoryUsageEventStore } from './usageEventRepository.js';
import { instrumentAiProvider, type UsageScope } from './usageInstrumentation.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';

const scope: UsageScope = { accountId: ACCOUNT, projectId: PROJECT, userId: null };

function fakeProvider(over: Partial<AIProvider> = {}): AIProvider {
  return {
    id: 'openai',
    name: 'OpenAI',
    description: 'fake provider',
    capabilities: ['chat', 'generate', 'embed', 'models'],
    isConfigured: () => true,
    models: () => [],
    chat: async () => ({ content: 'ok', model: 'gpt-4o-mini' }),
    generate: async () => ({ content: 'ok', model: 'gpt-4o-mini' }),
    embed: async () => ({ vectors: [[0]], model: 'text-embedding-3-small' }),
    ...over,
  };
}

function failingSink() {
  return { append: async () => { throw new Error('ledger down'); } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('instrumentAiProvider - chat', () => {
  it('records input and output token events with the resolved provider and model', async () => {
    const store = new InMemoryUsageEventStore();
    const provider = instrumentAiProvider({
      provider: fakeProvider({
        chat: async () => ({ content: 'hi', model: 'gpt-4o-mini', usage: { inputTokens: 12, outputTokens: 5 } }),
      }),
      sink: store,
      scope,
    });

    const result = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.content).toBe('hi');

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
    const byUnit = Object.fromEntries(events.map((e) => [e.unit, e]));
    expect(byUnit.input_token).toMatchObject({
      category: 'ai',
      provider: 'openai',
      operation: 'chat',
      quantity: 12,
      unit: 'input_token',
      success: true,
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: null,
      metadata: { model: 'gpt-4o-mini' },
    });
    expect(byUnit.output_token).toMatchObject({ operation: 'chat', quantity: 5, unit: 'output_token' });
  });

  it('emits only the present unit when usage is partial', async () => {
    const store = new InMemoryUsageEventStore();
    const provider = instrumentAiProvider({
      provider: fakeProvider({ chat: async () => ({ content: 'hi', model: 'm', usage: { inputTokens: 7 } }) }),
      sink: store,
      scope,
    });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ unit: 'input_token', quantity: 7 });
  });

  it('does not fabricate events when usage is absent or zero', async () => {
    const missing = new InMemoryUsageEventStore();
    await instrumentAiProvider({
      provider: fakeProvider({ chat: async () => ({ content: 'hi', model: 'm' }) }),
      sink: missing,
      scope,
    }).chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(await missing.list({ projectId: PROJECT })).toHaveLength(0);

    const zero = new InMemoryUsageEventStore();
    await instrumentAiProvider({
      provider: fakeProvider({ chat: async () => ({ content: 'hi', model: 'm', usage: { inputTokens: 0, outputTokens: 0 } }) }),
      sink: zero,
      scope,
    }).chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(await zero.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('rethrows the provider error unchanged and records nothing', async () => {
    const store = new InMemoryUsageEventStore();
    const boom = new Error('external 500');
    const provider = instrumentAiProvider({
      provider: fakeProvider({
        chat: async () => {
          throw boom;
        },
      }),
      sink: store,
      scope,
    });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBe(boom);
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('does not break a successful call when the usage append fails', async () => {
    const provider = instrumentAiProvider({
      provider: fakeProvider({
        chat: async () => ({ content: 'kept', model: 'm', usage: { inputTokens: 3 } }),
      }),
      sink: failingSink(),
      scope,
    });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'x' }] })).resolves.toMatchObject({
      content: 'kept',
    });
  });
});

describe('instrumentAiProvider - generate and embed', () => {
  it('records generate with operation generate', async () => {
    const store = new InMemoryUsageEventStore();
    await instrumentAiProvider({
      provider: fakeProvider({
        generate: async () => ({ content: 'draft', model: 'gpt-4o-mini', usage: { inputTokens: 20, outputTokens: 9 } }),
      }),
      sink: store,
      scope,
    }).generate({ prompt: 'write' });
    const events = await store.list({ projectId: PROJECT });
    const byUnit = Object.fromEntries(events.map((e) => [e.unit, [e.operation, e.quantity]]));
    expect(byUnit).toEqual({ input_token: ['generate', 20], output_token: ['generate', 9] });
  });

  it('emits exactly one summed input-token event for an embed call', async () => {
    const store = new InMemoryUsageEventStore();
    await instrumentAiProvider({
      provider: fakeProvider({
        embed: async () => ({ vectors: [[0], [1]], model: 'text-embedding-3-small', usage: { inputTokens: 42 } }),
      }),
      sink: store,
      scope,
    }).embed({ input: ['a', 'b'] });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'ai',
      provider: 'openai',
      operation: 'embed',
      quantity: 42,
      unit: 'input_token',
      success: true,
      metadata: { model: 'text-embedding-3-small' },
    });
  });

  it('does not estimate embedding tokens when usage is absent', async () => {
    const store = new InMemoryUsageEventStore();
    await instrumentAiProvider({
      provider: fakeProvider({ embed: async () => ({ vectors: [[0]], model: 'm' }) }),
      sink: store,
      scope,
    }).embed({ input: 'a' });
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });
});

describe('AIService.resolve instrumentation seam', () => {
  function container(store: InMemoryUsageEventStore): ServiceContainer {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'order', 'limit']) chain[method] = () => chain;
    chain.maybeSingle = async () => ({ data: { account_id: ACCOUNT, settings: {} }, error: null });
    return {
      sb: { from: () => chain },
      credentials: { reader: () => ({ get: async () => null }) },
      config: { env: { OPENAI_API_KEY: 'sk-test' } },
      usageEvents: store,
    } as unknown as ServiceContainer;
  }

  it('records chat usage through the store with real project/account scope', async () => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response(
          JSON.stringify({
            model: 'gpt-4o-mini',
            choices: [{ message: { content: 'Hello' } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    );
    const store = new InMemoryUsageEventStore();
    const resolved = await new AIService(container(store)).resolve(PROJECT);
    expect(resolved.provider.id).toBe('openai');

    await resolved.provider.chat({ messages: [{ role: 'user', content: 'hi' }] });

    const events = await store.list({ projectId: PROJECT });
    expect(Object.fromEntries(events.map((e) => [e.unit, e.quantity]))).toEqual({
      input_token: 5,
      output_token: 2,
    });
    expect(events[0]).toMatchObject({ accountId: ACCOUNT, projectId: PROJECT, userId: null, provider: 'openai' });
  });
});
