/**
 * DataForSEO logical-operation usage builders (R5.10.4).
 *
 * Pins the pure construction rules: one event per positive unit, scope from the
 * provider context, source identity retained, occurrences disambiguating
 * repeated operations, and malformed input skipped rather than emitted.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderContext, ProviderLogger } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import { buildDataForSeoUsageEvents, emitDataForSeoUsage } from './providerUsage.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const JOB = 'job-abc-123';

const noopLogger: ProviderLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function ctx(over: Partial<ProviderContext> = {}): ProviderContext {
  const store = new InMemoryUsageEventStore();
  const occurrences = new Map<string, number>();
  return {
    projectId: PROJECT,
    userId: USER,
    config: {},
    credentials: { get: async () => null, set: async () => {}, delete: async () => {} },
    logger: noopLogger,
    usage: {
      sink: store,
      sourceId: JOB,
      nextOccurrence: (op) => {
        const next = occurrences.get(op) ?? 0;
        occurrences.set(op, next + 1);
        return next;
      },
    },
    ...over,
  };
}

const PROVIDER = 'dataforseo';

describe('buildDataForSeoUsageEvents', () => {
  it('emits one event per positive fact with scope, source and provider', () => {
    const events = buildDataForSeoUsageEvents({
      ctx: ctx(),
      providerId: PROVIDER,
      facts: [
        { operation: 'serp_live', unit: 'serp_request', quantity: 3 },
        { operation: 'serp_live', unit: 'keyword', quantity: 3 },
      ],
      success: true,
      metadata: { mode: 'live' },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      accountId: null,
      projectId: PROJECT,
      userId: USER,
      category: 'dataforseo',
      provider: PROVIDER,
      operation: 'serp_live',
      unit: 'serp_request',
      quantity: 3,
      success: true,
      sourceId: JOB,
      metadata: { mode: 'live' },
    });
    expect(events[0]!.idempotencyKey).toBe(`v1|dataforseo|dataforseo|serp_live|serp_request|${JOB}|0`);
  });

  it('disambiguates repeated operations of the same kind with an occurrence', () => {
    const c = ctx();
    const first = buildDataForSeoUsageEvents({
      ctx: c,
      providerId: PROVIDER,
      facts: [{ operation: 'keyword_related', unit: 'request', quantity: 1 }],
      success: true,
    });
    const second = buildDataForSeoUsageEvents({
      ctx: c,
      providerId: PROVIDER,
      facts: [{ operation: 'keyword_related', unit: 'request', quantity: 1 }],
      success: true,
    });
    expect(first[0]!.idempotencyKey).not.toBe(second[0]!.idempotencyKey);
    expect(first[0]!.idempotencyKey).toContain('|0');
    expect(second[0]!.idempotencyKey).toContain('|1');
  });

  it('drops non-positive quantities and empty fact lists', () => {
    expect(
      buildDataForSeoUsageEvents({
        ctx: ctx(),
        providerId: PROVIDER,
        facts: [{ operation: 'keyword_research', unit: 'keyword', quantity: 0 }],
        success: true,
      }),
    ).toEqual([]);
    expect(
      buildDataForSeoUsageEvents({ ctx: ctx(), providerId: PROVIDER, facts: [], success: true }),
    ).toEqual([]);
  });

  it('returns nothing without a usage context or with an invalid scope', () => {
    expect(
      buildDataForSeoUsageEvents({
        ctx: ctx({ usage: undefined }),
        providerId: PROVIDER,
        facts: [{ operation: 'serp_live', unit: 'serp_request', quantity: 1 }],
        success: true,
      }),
    ).toEqual([]);
    expect(
      buildDataForSeoUsageEvents({
        ctx: ctx({ projectId: 'p-1' }),
        providerId: PROVIDER,
        facts: [{ operation: 'serp_live', unit: 'serp_request', quantity: 1 }],
        success: true,
      }),
    ).toEqual([]);
    expect(
      buildDataForSeoUsageEvents({
        ctx: ctx(),
        providerId: 'Not Valid',
        facts: [{ operation: 'serp_live', unit: 'serp_request', quantity: 1 }],
        success: true,
      }),
    ).toEqual([]);
  });

  it('drops an over-long source id rather than emitting an invalid event', () => {
    const events = buildDataForSeoUsageEvents({
      ctx: ctx({ usage: { sink: new InMemoryUsageEventStore(), sourceId: 'x'.repeat(201), nextOccurrence: () => 0 } }),
      providerId: PROVIDER,
      facts: [{ operation: 'serp_live', unit: 'serp_request', quantity: 1 }],
      success: true,
    });
    expect(events[0]!.sourceId).toBeNull();
  });
});

describe('emitDataForSeoUsage', () => {
  it('appends to the sink, and never throws when the sink fails', async () => {
    const store = new InMemoryUsageEventStore();
    await emitDataForSeoUsage({
      ctx: ctx({ usage: { sink: store, sourceId: JOB, nextOccurrence: () => 0 } }),
      providerId: PROVIDER,
      facts: [{ operation: 'serp_live', unit: 'serp_request', quantity: 2 }],
      success: true,
    });
    expect(await store.list({ projectId: PROJECT })).toHaveLength(1);

    const errorSpy = vi.fn();
    await expect(
      emitDataForSeoUsage({
        ctx: ctx({
          logger: { ...noopLogger, error: errorSpy },
          usage: {
            sink: { append: async () => { throw new Error('ledger down'); } },
            sourceId: JOB,
            nextOccurrence: () => 0,
          },
        }),
        providerId: PROVIDER,
        facts: [{ operation: 'serp_live', unit: 'serp_request', quantity: 1 }],
        success: true,
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});
