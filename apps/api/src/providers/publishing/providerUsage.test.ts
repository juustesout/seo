/**
 * Publishing usage accounting (R5.10.6).
 *
 * Pins the fact shape (one real publication request -> one `publish_attempt`),
 * the invalid-scope guard, occurrence-based idempotency, the retry-aware
 * occurrence base (a retried job execution must not deduplicate a genuine second
 * remote attempt), and best-effort append.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderUsageContext } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import {
  PUBLISH_OCCURRENCE_STRIDE,
  buildPublishAttemptUsageEvent,
  emitPublishAttemptUsage,
  publishUsageOccurrenceBase,
  publishUsageObserver,
} from './providerUsage.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const JOB = 'job-r5-106';

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

describe('buildPublishAttemptUsageEvent', () => {
  it('builds one publish_attempt fact for a real publication request', () => {
    const event = buildPublishAttemptUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: PROJECT,
      userId: USER,
      provider: 'wordpress',
      operation: 'publish',
      success: true,
    });
    expect(event).toMatchObject({
      accountId: null,
      projectId: PROJECT,
      userId: USER,
      category: 'publishing',
      provider: 'wordpress',
      operation: 'publish',
      quantity: 1,
      unit: 'publish_attempt',
      success: true,
      sourceId: JOB,
    });
    expect(event?.idempotencyKey).toBe(`v1|publishing|wordpress|publish|publish_attempt|${JOB}|0`);
  });

  it('refuses a non-project scope', () => {
    expect(
      buildPublishAttemptUsageEvent({
        usage: usage(new InMemoryUsageEventStore()),
        projectId: '',
        userId: null,
        provider: 'x',
        operation: 'publish',
        success: true,
      }),
    ).toBeNull();
  });

  it('refuses an invalid provider or operation token', () => {
    const base = {
      usage: usage(new InMemoryUsageEventStore()),
      projectId: PROJECT,
      userId: null,
      operation: 'publish' as const,
      success: true,
    };
    expect(buildPublishAttemptUsageEvent({ ...base, provider: 'WordPress Site' })).toBeNull();
  });

  it('uses a distinct occurrence per request of the same operation', () => {
    const u = usage(new InMemoryUsageEventStore());
    const first = buildPublishAttemptUsageEvent({ usage: u, projectId: PROJECT, userId: null, provider: 'x', operation: 'publish', success: false });
    const second = buildPublishAttemptUsageEvent({ usage: u, projectId: PROJECT, userId: null, provider: 'x', operation: 'publish', success: true });
    expect(first?.idempotencyKey).toContain('|0');
    expect(second?.idempotencyKey).toContain('|1');
    expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
  });

  it('keeps a null source id non-deduplicatable', () => {
    const event = buildPublishAttemptUsageEvent({
      usage: usage(new InMemoryUsageEventStore(), null),
      projectId: PROJECT,
      userId: null,
      provider: 'wordpress',
      operation: 'publish',
      success: true,
    });
    expect(event?.idempotencyKey).toBeNull();
  });

  it('attaches caller metadata such as hasLink for allowance attribution', () => {
    const event = buildPublishAttemptUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: PROJECT,
      userId: USER,
      provider: 'x',
      operation: 'publish',
      success: true,
      metadata: { hasLink: true },
    });
    expect(event?.metadata).toEqual({ hasLink: true });
  });
});

describe('publishUsageOccurrenceBase', () => {
  it('is zero for the first execution and strides once per retry', () => {
    expect(publishUsageOccurrenceBase(0)).toBe(0);
    expect(publishUsageOccurrenceBase(1)).toBe(PUBLISH_OCCURRENCE_STRIDE);
    expect(publishUsageOccurrenceBase(2)).toBe(2 * PUBLISH_OCCURRENCE_STRIDE);
  });

  it('treats a missing or invalid retry count as no retries', () => {
    expect(publishUsageOccurrenceBase(undefined)).toBe(0);
    expect(publishUsageOccurrenceBase(null)).toBe(0);
    expect(publishUsageOccurrenceBase(-1)).toBe(0);
    expect(publishUsageOccurrenceBase(1.5)).toBe(0);
  });
});

describe('emitPublishAttemptUsage', () => {
  it('appends the fact best-effort', async () => {
    const store = new InMemoryUsageEventStore();
    await emitPublishAttemptUsage({
      usage: usage(store),
      projectId: PROJECT,
      userId: USER,
      provider: 'wordpress',
      operation: 'publish_update',
      success: false,
    });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: 'publishing', unit: 'publish_attempt', operation: 'publish_update', success: false, sourceId: JOB });
  });

  it('does not append when the scope cannot form a fact', async () => {
    const append = vi.fn();
    await emitPublishAttemptUsage({
      usage: usage({ append }),
      projectId: '',
      userId: null,
      provider: 'x',
      operation: 'publish',
      success: true,
    });
    expect(append).not.toHaveBeenCalled();
  });

  it('swallows a persistence failure', async () => {
    const append = vi.fn(async () => {
      throw new Error('ledger down');
    });
    await expect(
      emitPublishAttemptUsage({ usage: usage({ append }), projectId: PROJECT, userId: null, provider: 'x', operation: 'publish', success: true }),
    ).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledTimes(1);
  });
});

describe('publishUsageObserver', () => {
  it('is undefined without a usage context', () => {
    expect(publishUsageObserver({ usage: undefined, projectId: PROJECT, userId: null }, 'x')).toBeUndefined();
  });

  it('records each observed request once', async () => {
    const store = new InMemoryUsageEventStore();
    const observe = publishUsageObserver({ usage: usage(store), projectId: PROJECT, userId: USER }, 'x');
    await observe!('publish', true);
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: 'x', operation: 'publish', unit: 'publish_attempt', success: true });
  });

  it('carries observer metadata into every emitted fact', async () => {
    const store = new InMemoryUsageEventStore();
    const observe = publishUsageObserver({ usage: usage(store), projectId: PROJECT, userId: USER }, 'x', {
      hasLink: true,
    });
    await observe!('publish', true);
    const events = await store.list({ projectId: PROJECT });
    expect(events[0]?.metadata).toEqual({ hasLink: true });
  });
});
