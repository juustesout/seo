/**
 * Media usage accounting (R5.10.7).
 *
 * Pins the fact shape (one real external media request -> one fact), the unit
 * mapping (search = `request`, generation = `image_generation`), the
 * invalid-scope guard, occurrence idempotency and the retry-aware occurrence
 * base.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MediaUsageScope, ProviderUsageContext } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import {
  USAGE_RETRY_OCCURRENCE_STRIDE,
  retryOccurrenceBase,
} from '../../services/usageInstrumentation.js';
import { buildMediaUsageEvent, emitMediaUsage, mediaUsageUnit } from './mediaUsage.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const JOB = 'job-r5-107-media';

function scope(
  store: { append: (events: never[]) => unknown },
  sourceId: string | null = JOB,
  base = 0,
): MediaUsageScope {
  const occurrences = new Map<string, number>();
  const usage: ProviderUsageContext = {
    sink: store as unknown as ProviderUsageContext['sink'],
    sourceId,
    nextOccurrence: (operation) => {
      const next = occurrences.get(operation) ?? base;
      occurrences.set(operation, next + 1);
      return next;
    },
  };
  return { projectId: PROJECT, userId: USER, usage };
}

describe('mediaUsageUnit', () => {
  it('maps each operation to its stable unit', () => {
    expect(mediaUsageUnit('media_search')).toBe('request');
    expect(mediaUsageUnit('image_generate')).toBe('image_generation');
  });
});

describe('buildMediaUsageEvent', () => {
  it('builds one request fact for an external search', () => {
    const event = buildMediaUsageEvent({
      scope: scope(new InMemoryUsageEventStore()),
      provider: 'unsplash',
      operation: 'media_search',
      success: true,
    });
    expect(event).toMatchObject({
      accountId: null,
      projectId: PROJECT,
      userId: USER,
      category: 'media',
      provider: 'unsplash',
      operation: 'media_search',
      quantity: 1,
      unit: 'request',
      success: true,
      sourceId: JOB,
    });
    expect(event?.idempotencyKey).toBe(`v1|media|unsplash|media_search|request|${JOB}|0`);
  });

  it('builds one generation fact carrying the model', () => {
    const event = buildMediaUsageEvent({
      scope: scope(new InMemoryUsageEventStore()),
      provider: 'openai_media',
      operation: 'image_generate',
      success: true,
      model: 'dall-e-3',
    });
    expect(event).toMatchObject({
      category: 'media',
      provider: 'openai_media',
      operation: 'image_generate',
      unit: 'image_generation',
      metadata: { model: 'dall-e-3' },
    });
  });

  it('refuses a non-UUID project or invalid provider token', () => {
    expect(
      buildMediaUsageEvent({
        scope: { ...scope(new InMemoryUsageEventStore()), projectId: '' },
        provider: 'unsplash',
        operation: 'media_search',
        success: true,
      }),
    ).toBeNull();
    expect(
      buildMediaUsageEvent({
        scope: scope(new InMemoryUsageEventStore()),
        provider: 'Unsplash Photo',
        operation: 'media_search',
        success: true,
      }),
    ).toBeNull();
  });

  it('uses a distinct occurrence per external request', () => {
    const s = scope(new InMemoryUsageEventStore());
    const first = buildMediaUsageEvent({ scope: s, provider: 'unsplash', operation: 'media_search', success: true });
    const second = buildMediaUsageEvent({ scope: s, provider: 'unsplash', operation: 'media_search', success: false });
    expect(first?.idempotencyKey).toContain('|0');
    expect(second?.idempotencyKey).toContain('|1');
  });

  it('keeps a retried job execution distinct from the previous one', () => {
    const s = scope(new InMemoryUsageEventStore(), JOB, retryOccurrenceBase(1));
    const event = buildMediaUsageEvent({ scope: s, provider: 'unsplash', operation: 'media_search', success: true });
    expect(event?.idempotencyKey).toBe(`v1|media|unsplash|media_search|request|${JOB}|${USAGE_RETRY_OCCURRENCE_STRIDE}`);
  });

  it('keeps a null source id non-deduplicatable', () => {
    const event = buildMediaUsageEvent({
      scope: scope(new InMemoryUsageEventStore(), null),
      provider: 'unsplash',
      operation: 'media_search',
      success: true,
    });
    expect(event?.idempotencyKey).toBeNull();
  });
});

describe('emitMediaUsage', () => {
  it('appends the fact best-effort', async () => {
    const store = new InMemoryUsageEventStore();
    await emitMediaUsage({ scope: scope(store), provider: 'unsplash', operation: 'media_search', success: true });
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: 'media', unit: 'request', sourceId: JOB });
  });

  it('swallows a persistence failure', async () => {
    const append = vi.fn(async () => {
      throw new Error('ledger down');
    });
    await expect(
      emitMediaUsage({ scope: scope({ append }), provider: 'unsplash', operation: 'media_search', success: true }),
    ).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledTimes(1);
  });
});
