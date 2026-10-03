/**
 * GA4 usage accounting (P4.5).
 *
 * Pins the fact shape (one real Analytics API request -> one `ga4_request`
 * under the `google` category), the nullable project guard that keeps
 * account-scoped discovery from fabricating a project fact, the
 * occurrence-based idempotency key, and best-effort append.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderUsageContext } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import { buildGa4RequestUsageEvent, emitGa4RequestUsage } from './providerUsage.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const JOB = 'job-p45-ga4';

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

describe('buildGa4RequestUsageEvent', () => {
  it('builds one ga4_request fact under the google category', () => {
    const event = buildGa4RequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: PROJECT,
      userId: 'user-1',
      operation: 'page_traffic',
      success: true,
    });
    expect(event).toMatchObject({
      accountId: null,
      projectId: PROJECT,
      userId: 'user-1',
      category: 'google',
      provider: 'ga4',
      operation: 'page_traffic',
      quantity: 1,
      unit: 'ga4_request',
      success: true,
      sourceId: JOB,
    });
    expect(event?.idempotencyKey).toBe(`v1|google|ga4|page_traffic|ga4_request|${JOB}|0`);
  });

  it('refuses a non-project scope instead of inventing one', () => {
    const event = buildGa4RequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: '',
      userId: null,
      operation: 'list_properties',
      success: true,
    });
    expect(event).toBeNull();
  });

  it('refuses an invalid operation token', () => {
    const event = buildGa4RequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: PROJECT,
      userId: null,
      operation: 'Page Traffic',
      success: true,
    });
    expect(event).toBeNull();
  });

  it('uses a distinct occurrence per request of the same operation', () => {
    const u = usage(new InMemoryUsageEventStore());
    const first = buildGa4RequestUsageEvent({ usage: u, projectId: PROJECT, userId: null, operation: 'page_traffic', success: true });
    const second = buildGa4RequestUsageEvent({ usage: u, projectId: PROJECT, userId: null, operation: 'page_traffic', success: false });
    expect(first?.idempotencyKey).toContain('|0');
    expect(second?.idempotencyKey).toContain('|1');
    expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
  });

  it('keeps a null source id non-deduplicatable (interactive reads)', () => {
    const event = buildGa4RequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore(), null),
      projectId: PROJECT,
      userId: null,
      operation: 'page_traffic',
      success: true,
    });
    expect(event?.idempotencyKey).toBeNull();
  });
});

describe('emitGa4RequestUsage', () => {
  it('appends the fact best-effort', async () => {
    const store = new InMemoryUsageEventStore();
    await emitGa4RequestUsage({ usage: usage(store), projectId: PROJECT, userId: null, operation: 'page_traffic', success: true });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: 'google', provider: 'ga4', unit: 'ga4_request', sourceId: JOB });
  });

  it('does not append when the scope cannot form a fact', async () => {
    const append = vi.fn();
    await emitGa4RequestUsage({
      usage: usage({ append }),
      projectId: '',
      userId: null,
      operation: 'page_traffic',
      success: true,
    });
    expect(append).not.toHaveBeenCalled();
  });

  it('swallows a persistence failure', async () => {
    const append = vi.fn(async () => {
      throw new Error('ledger down');
    });
    await expect(
      emitGa4RequestUsage({ usage: usage({ append }), projectId: PROJECT, userId: null, operation: 'page_traffic', success: true }),
    ).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledTimes(1);
  });
});
