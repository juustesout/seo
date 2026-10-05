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
import { instrumentAiProvider, jobUsageEvent, type UsageScope } from './usageInstrumentation.js';

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

  // R5.10.8 (C3): the logical wrapper must never meter embeddings. The physical
  // request observer at the concrete embedder owns that fact; emitting here too
  // would double count a summed multi-batch embed.
  it('delegates embed without emitting any usage fact even when tokens are reported', async () => {
    const store = new InMemoryUsageEventStore();
    const expected = { vectors: [[0], [1]], model: 'text-embedding-3-small', usage: { inputTokens: 42 } };
    const result = await instrumentAiProvider({
      provider: fakeProvider({ embed: async () => expected }),
      sink: store,
      scope,
    }).embed({ input: ['a', 'b'] });
    expect(result).toBe(expected);
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

  // R5.10.8 (C2): the acting user is threaded from the authenticated edge, so an
  // interactive AI call is attributed to that user; system/background callers
  // that do not pass one keep null (honest "no acting user").
  it('attributes chat usage to the acting user when one is threaded', async () => {
    const ACTOR = '55555555-5555-4555-8555-555555555555';
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
    const resolved = await new AIService(container(store)).resolve(PROJECT, ACTOR);
    await resolved.provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.userId === ACTOR)).toBe(true);
  });
});

describe('P11 funding attribution', () => {
  function containerWithKey(
    store: InMemoryUsageEventStore,
    opts: { envKey?: string; projectKey?: string | null },
  ): ServiceContainer {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'order', 'limit']) chain[method] = () => chain;
    chain.maybeSingle = async () => ({ data: { account_id: ACCOUNT, settings: {} }, error: null });
    return {
      sb: { from: () => chain },
      credentials: { reader: () => ({ get: async () => opts.projectKey ?? null }) },
      config: { env: opts.envKey ? { OPENAI_API_KEY: opts.envKey } : {} },
      usageEvents: store,
    } as unknown as ServiceContainer;
  }

  function stubChat(): void {
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
  }

  it('marks a server env key as operator_funded', async () => {
    stubChat();
    const store = new InMemoryUsageEventStore();
    const resolved = await new AIService(containerWithKey(store, { envKey: 'sk-test' })).resolve(PROJECT);
    await resolved.provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.fundingSource === 'operator_funded')).toBe(true);
  });

  it('marks a user-supplied BYOK key as byok', async () => {
    stubChat();
    const store = new InMemoryUsageEventStore();
    const resolved = await new AIService(containerWithKey(store, { envKey: 'sk-env', projectKey: 'sk-byok' })).resolve(PROJECT);
    await resolved.provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.fundingSource === 'byok')).toBe(true);
  });

  it('leaves fundingSource null when a scope does not set one', async () => {
    const store = new InMemoryUsageEventStore();
    await instrumentAiProvider({
      provider: fakeProvider({ chat: async () => ({ content: 'x', model: 'm', usage: { inputTokens: 3 } }) }),
      sink: store,
      scope: { accountId: ACCOUNT, projectId: PROJECT, userId: null },
    }).chat({ messages: [{ role: 'user', content: 'hi' }] });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]!.fundingSource).toBeNull();
  });
});

describe('jobUsageEvent', () => {
  const USER = '44444444-4444-4444-8444-444444444444';
  const record = (over: Partial<Parameters<typeof jobUsageEvent>[0]['job']> = {}) => ({
    id: PROJECT,
    project_id: PROJECT,
    provider: 'dataforseo',
    job_type: 'dataforseo_rank_sync',
    created_by: USER,
    retry_count: 2,
    started_at: new Date().toISOString(),
    ...over,
  });

  it('builds one terminal job fact with source id, retry count and duration', () => {
    const event = jobUsageEvent({
      job: record(),
      success: true,
      status: 'completed',
      durationMs: 1234.6,
    });
    expect(event).toMatchObject({
      accountId: null,
      projectId: PROJECT,
      userId: USER,
      category: 'job',
      provider: 'dataforseo',
      operation: 'dataforseo_rank_sync',
      quantity: 1,
      unit: 'job',
      success: true,
      sourceId: PROJECT,
      metadata: { retryCount: 2, status: 'completed', durationMs: 1235 },
    });
    expect(event!.idempotencyKey).toBe(`v1|job|dataforseo|dataforseo_rank_sync|job|${PROJECT}|0`);
  });

  it('records a terminal failure without inventing units', () => {
    const event = jobUsageEvent({ job: record(), success: false, status: 'failed' });
    expect(event).toMatchObject({ success: false, quantity: 1, unit: 'job', metadata: { retryCount: 2, status: 'failed' } });
    expect(event!.metadata).not.toHaveProperty('durationMs');
  });

  it('nulls a non-UUID acting user and rejects invalid scope or tokens', () => {
    expect(jobUsageEvent({ job: record({ created_by: 'u1' }), success: true, status: 'completed' })!.userId).toBeNull();
    expect(jobUsageEvent({ job: record({ project_id: 'p-1' }), success: true, status: 'completed' })).toBeNull();
    expect(jobUsageEvent({ job: record({ provider: 'Not Valid' }), success: true, status: 'completed' })).toBeNull();
    expect(jobUsageEvent({ job: record({ job_type: 'Bad-Type' }), success: true, status: 'completed' })).toBeNull();
  });
});
