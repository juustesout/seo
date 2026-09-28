/**
 * Embedding usage accounting (R5.10.7).
 *
 * Pins the physical-request model: one `POST /embeddings` request -> one
 * `ai`/`embed`/`input_token` fact carrying the provider-reported token count,
 * so a batched embed records one fact per batch instead of one summed fact. Also
 * pins the invalid-scope guard, occurrence idempotency, retry-aware occurrence
 * bases and best-effort append.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderUsageContext } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import {
  USAGE_RETRY_OCCURRENCE_STRIDE,
  retryOccurrenceBase,
  usageScopeContext,
} from '../../services/usageInstrumentation.js';
import { OpenAiCompatibleEmbedder } from './embedding.js';
import {
  buildEmbeddingUsageEvent,
  emitEmbeddingUsage,
  embeddingUsageObserver,
} from './embeddingUsage.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const JOB = 'job-r5-107-embed';

function usage(
  store: { append: (events: never[]) => unknown },
  sourceId: string | null = JOB,
  base = 0,
): ProviderUsageContext {
  const occurrences = new Map<string, number>();
  return {
    sink: store as unknown as ProviderUsageContext['sink'],
    sourceId,
    nextOccurrence: (operation) => {
      const next = occurrences.get(operation) ?? base;
      occurrences.set(operation, next + 1);
      return next;
    },
  };
}

describe('buildEmbeddingUsageEvent', () => {
  it('builds one input_token fact for a physical request', () => {
    const event = buildEmbeddingUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: PROJECT,
      userId: USER,
      model: 'text-embedding-3-small',
      inputTokens: 42,
      batchSize: 8,
    });
    expect(event).toMatchObject({
      accountId: null,
      projectId: PROJECT,
      userId: USER,
      category: 'ai',
      provider: 'openai',
      operation: 'embed',
      quantity: 42,
      unit: 'input_token',
      success: true,
      sourceId: JOB,
      metadata: { model: 'text-embedding-3-small', batchSize: 8 },
    });
    expect(event?.idempotencyKey).toBe(`v1|ai|openai|embed|input_token|${JOB}|0`);
  });

  it('refuses a non-UUID project', () => {
    expect(
      buildEmbeddingUsageEvent({
        usage: usage(new InMemoryUsageEventStore()),
        projectId: '',
        userId: null,
        model: 'm',
        inputTokens: 1,
        batchSize: 1,
      }),
    ).toBeNull();
  });

  it('refuses a non-positive or non-finite token count', () => {
    const base = {
      usage: usage(new InMemoryUsageEventStore()),
      projectId: PROJECT,
      userId: null,
      model: 'm',
      batchSize: 1,
    };
    expect(buildEmbeddingUsageEvent({ ...base, inputTokens: 0 })).toBeNull();
    expect(buildEmbeddingUsageEvent({ ...base, inputTokens: -5 })).toBeNull();
    expect(buildEmbeddingUsageEvent({ ...base, inputTokens: Number.NaN })).toBeNull();
  });

  it('uses a distinct occurrence per physical request', () => {
    const u = usage(new InMemoryUsageEventStore());
    const base = { usage: u, projectId: PROJECT, userId: null, model: 'm', batchSize: 8 };
    const first = buildEmbeddingUsageEvent({ ...base, inputTokens: 10 });
    const second = buildEmbeddingUsageEvent({ ...base, inputTokens: 10 });
    expect(first?.idempotencyKey).toContain('|0');
    expect(second?.idempotencyKey).toContain('|1');
  });

  it('keeps a null source id non-deduplicatable', () => {
    const event = buildEmbeddingUsageEvent({
      usage: usage(new InMemoryUsageEventStore(), null),
      projectId: PROJECT,
      userId: null,
      model: 'm',
      inputTokens: 10,
      batchSize: 8,
    });
    expect(event?.idempotencyKey).toBeNull();
  });

  it('keeps a retried job execution distinct from the previous one', () => {
    const u = usage(new InMemoryUsageEventStore(), JOB, retryOccurrenceBase(1));
    const event = buildEmbeddingUsageEvent({
      usage: u,
      projectId: PROJECT,
      userId: null,
      model: 'm',
      inputTokens: 10,
      batchSize: 8,
    });
    expect(event?.idempotencyKey).toBe(`v1|ai|openai|embed|input_token|${JOB}|${USAGE_RETRY_OCCURRENCE_STRIDE}`);
  });
});

describe('emitEmbeddingUsage', () => {
  it('appends the fact best-effort', async () => {
    const store = new InMemoryUsageEventStore();
    await emitEmbeddingUsage({
      usage: usage(store),
      projectId: PROJECT,
      userId: USER,
      model: 'text-embedding-3-small',
      inputTokens: 12,
      batchSize: 4,
    });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'embed', unit: 'input_token', quantity: 12, success: true });
  });

  it('swallows a persistence failure', async () => {
    const append = vi.fn(async () => {
      throw new Error('ledger down');
    });
    await expect(
      emitEmbeddingUsage({
        usage: usage({ append }),
        projectId: PROJECT,
        userId: null,
        model: 'm',
        inputTokens: 12,
        batchSize: 4,
      }),
    ).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledTimes(1);
  });
});

describe('embeddingUsageObserver', () => {
  it('is undefined without a usage context', () => {
    expect(embeddingUsageObserver({ usage: undefined, projectId: PROJECT, userId: null })).toBeUndefined();
  });

  it('records each observation once, best-effort', async () => {
    const store = new InMemoryUsageEventStore();
    const observe = embeddingUsageObserver({ usage: usage(store), projectId: PROJECT, userId: USER });
    observe!({ model: 'm', inputTokens: 7, batchSize: 3 });
    observe!({ model: 'm', inputTokens: 9, batchSize: 3 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.quantity).sort((a, b) => a - b)).toEqual([7, 9]);
  });
});

describe('OpenAiCompatibleEmbedder physical-request observation', () => {
  it('reports one observation per batch with the provider-reported token count', async () => {
    const fetchFn = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: body.input.map(() => ({ embedding: [0.1, 0.2] })),
          usage: { prompt_tokens: 100 + body.input.length },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchFn);
    try {
      const embedder = new OpenAiCompatibleEmbedder({ apiKey: 'k', model: 'text-embedding-3-small' }, 2);
      const observer = vi.fn();
      const vectors = await embedder.embed(
        Array.from({ length: 20 }, (_, i) => `t${i}`),
        observer,
      );
      expect(vectors).toHaveLength(20);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(observer).toHaveBeenCalledTimes(3);
      expect(observer).toHaveBeenNthCalledWith(1, { model: 'text-embedding-3-small', inputTokens: 108, batchSize: 8 });
      expect(observer).toHaveBeenNthCalledWith(2, { model: 'text-embedding-3-small', inputTokens: 108, batchSize: 8 });
      expect(observer).toHaveBeenNthCalledWith(3, { model: 'text-embedding-3-small', inputTokens: 104, batchSize: 4 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not observe when the provider omits usage', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchFn);
    try {
      const embedder = new OpenAiCompatibleEmbedder({ apiKey: 'k' }, 2);
      const observer = vi.fn();
      await embedder.embed(['a'], observer);
      expect(observer).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('records nothing when the request fails before a token count exists', async () => {
    const fetchFn = vi.fn(async () =>
      new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );
    vi.stubGlobal('fetch', fetchFn);
    try {
      const embedder = new OpenAiCompatibleEmbedder({ apiKey: 'k' }, 2);
      const observer = vi.fn();
      await expect(embedder.embed(['a'], observer)).rejects.toThrow('Embedding API 500');
      expect(observer).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('usageScopeContext (R5.10.7 generic seam)', () => {
  it('returns undefined without a sink so callers can skip usage entirely', () => {
    expect(usageScopeContext({ sink: undefined, sourceId: JOB })).toBeUndefined();
  });

  it('seeds the occurrence counter at the supplied retry-aware base', () => {
    const store = new InMemoryUsageEventStore();
    const ctx = usageScopeContext({ sink: store, sourceId: JOB, occurrenceBase: retryOccurrenceBase(2) })!;
    expect(ctx.nextOccurrence('embed')).toBe(2 * USAGE_RETRY_OCCURRENCE_STRIDE);
    expect(ctx.nextOccurrence('embed')).toBe(2 * USAGE_RETRY_OCCURRENCE_STRIDE + 1);
  });
});
