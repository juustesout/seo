/**
 * GSC usage accounting (R5.10.5).
 *
 * Pins the fact shape (one real request -> one `gsc_request`), the nullable
 * project guard that keeps account-scoped calls from fabricating a project
 * fact, the occurrence-based idempotency key, and best-effort append.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderUsageContext } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import { buildGscRequestUsageEvent, emitGscRequestUsage } from './providerUsage.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const JOB = 'job-r5-105';

function usage(store: { append: (events: never[]) => unknown }, sourceId: string | null = JOB): ProviderUsageContext {
  const occurrences = new Map<string, number>();
  return {
    sink: store as unknown as ProviderUsageContext['sink'],
    sourceId,
    nextOccurrence: (operation) => {
      const next = occurrences.get(operation) ?? 0;
      occurrences.set(operation, next + 1);
      return next;
    },
  };
}

describe('buildGscRequestUsageEvent', () => {
  it('builds one gsc_request fact for a real request', () => {
    const event = buildGscRequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: PROJECT,
      userId: null,
      operation: 'search_analytics',
      success: true,
    });
    expect(event).toMatchObject({
      accountId: null,
      projectId: PROJECT,
      userId: null,
      category: 'dataforseo',
      provider: 'gsc',
      operation: 'search_analytics',
      quantity: 1,
      unit: 'gsc_request',
      success: true,
      sourceId: JOB,
    });
    expect(event?.idempotencyKey).toBe(`v1|dataforseo|gsc|search_analytics|gsc_request|${JOB}|0`);
  });

  it('refuses a non-project scope instead of inventing one', () => {
    const event = buildGscRequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: '',
      userId: null,
      operation: 'list_sites',
      success: true,
    });
    expect(event).toBeNull();
  });

  it('refuses an invalid operation token', () => {
    const event = buildGscRequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: PROJECT,
      userId: null,
      operation: 'Search Analytics',
      success: true,
    });
    expect(event).toBeNull();
  });

  it('uses a distinct occurrence per request of the same operation', () => {
    const u = usage(new InMemoryUsageEventStore());
    const first = buildGscRequestUsageEvent({ usage: u, projectId: PROJECT, userId: null, operation: 'search_analytics', success: true });
    const second = buildGscRequestUsageEvent({ usage: u, projectId: PROJECT, userId: null, operation: 'search_analytics', success: false });
    expect(first?.idempotencyKey).toContain('|0');
    expect(second?.idempotencyKey).toContain('|1');
    expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
  });

  it('keeps a null source id non-deduplicatable', () => {
    const event = buildGscRequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore(), null),
      projectId: PROJECT,
      userId: null,
      operation: 'list_sites',
      success: true,
    });
    expect(event?.idempotencyKey).toBeNull();
  });
});

describe('emitGscRequestUsage', () => {
  it('appends the fact best-effort', async () => {
    const store = new InMemoryUsageEventStore();
    await emitGscRequestUsage({ usage: usage(store), projectId: PROJECT, userId: null, operation: 'list_sites', success: true });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: 'gsc', unit: 'gsc_request', sourceId: JOB });
  });

  it('does not append when the scope cannot form a fact', async () => {
    const append = vi.fn();
    await emitGscRequestUsage({
      usage: usage({ append }),
      projectId: '',
      userId: null,
      operation: 'list_sites',
      success: true,
    });
    expect(append).not.toHaveBeenCalled();
  });

  it('swallows a persistence failure and logs nothing fatal', async () => {
    const append = vi.fn(async () => {
      throw new Error('ledger down');
    });
    await expect(
      emitGscRequestUsage({ usage: usage({ append }), projectId: PROJECT, userId: null, operation: 'list_sites', success: true }),
    ).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledTimes(1);
  });
});
