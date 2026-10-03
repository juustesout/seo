/**
 * Google Ads usage accounting (P5).
 *
 * Pins the fact shape (one real Ads API request -> one `ads_request` under the
 * `google` category), the nullable project guard that keeps account-scoped
 * discovery from fabricating a project fact, the occurrence-based idempotency
 * key, and best-effort append.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderUsageContext } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import { buildAdsRequestUsageEvent, emitAdsRequestUsage } from './providerUsage.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const JOB = 'job-p5-ads';

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

describe('buildAdsRequestUsageEvent', () => {
  it('builds one ads_request fact under the google category', () => {
    const event = buildAdsRequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: PROJECT,
      userId: 'user-1',
      operation: 'search_terms',
      success: true,
    });
    expect(event).toMatchObject({
      accountId: null,
      projectId: PROJECT,
      userId: 'user-1',
      category: 'google',
      provider: 'ads',
      operation: 'search_terms',
      quantity: 1,
      unit: 'ads_request',
      success: true,
      sourceId: JOB,
    });
    expect(event?.idempotencyKey).toBe(`v1|google|ads|search_terms|ads_request|${JOB}|0`);
  });

  it('refuses a non-project scope instead of inventing one', () => {
    const event = buildAdsRequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: '',
      userId: null,
      operation: 'list_accessible_customers',
      success: true,
    });
    expect(event).toBeNull();
  });

  it('refuses an invalid operation token', () => {
    const event = buildAdsRequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore()),
      projectId: PROJECT,
      userId: null,
      operation: 'Search Terms',
      success: true,
    });
    expect(event).toBeNull();
  });

  it('uses a distinct occurrence per request of the same operation', () => {
    const u = usage(new InMemoryUsageEventStore());
    const first = buildAdsRequestUsageEvent({ usage: u, projectId: PROJECT, userId: null, operation: 'keywords', success: true });
    const second = buildAdsRequestUsageEvent({ usage: u, projectId: PROJECT, userId: null, operation: 'keywords', success: false });
    expect(first?.idempotencyKey).toContain('|0');
    expect(second?.idempotencyKey).toContain('|1');
    expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
  });

  it('keeps a null source id non-deduplicatable (interactive reads)', () => {
    const event = buildAdsRequestUsageEvent({
      usage: usage(new InMemoryUsageEventStore(), null),
      projectId: PROJECT,
      userId: null,
      operation: 'search_terms',
      success: true,
    });
    expect(event?.idempotencyKey).toBeNull();
  });
});

describe('emitAdsRequestUsage', () => {
  it('appends the fact best-effort', async () => {
    const store = new InMemoryUsageEventStore();
    await emitAdsRequestUsage({ usage: usage(store), projectId: PROJECT, userId: null, operation: 'keywords', success: true });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: 'google', provider: 'ads', unit: 'ads_request', sourceId: JOB });
  });

  it('does not append when the scope cannot form a fact', async () => {
    const append = vi.fn();
    await emitAdsRequestUsage({
      usage: usage({ append }),
      projectId: '',
      userId: null,
      operation: 'keywords',
      success: true,
    });
    expect(append).not.toHaveBeenCalled();
  });

  it('swallows a persistence failure', async () => {
    const append = vi.fn(async () => {
      throw new Error('ledger down');
    });
    await expect(
      emitAdsRequestUsage({ usage: usage({ append }), projectId: PROJECT, userId: null, operation: 'keywords', success: true }),
    ).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledTimes(1);
  });
});
