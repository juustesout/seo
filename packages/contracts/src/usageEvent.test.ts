import { describe, expect, it } from 'vitest';
import {
  USAGE_CATEGORIES,
  USAGE_UNITS,
  isValidUsageCategory,
  isValidUsageEvent,
  isValidUsageMetadata,
  isValidUsageQuantity,
  isValidUsageUnit,
  usageEventIdempotencyKey,
  type UsageEvent,
} from './usageEvent.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

function baseEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: ID,
    occurredAt: '2026-01-01T00:00:00.000Z',
    accountId: ACCOUNT,
    projectId: PROJECT,
    userId: USER,
    category: 'ai',
    provider: 'openai',
    operation: 'chat',
    quantity: 1200,
    unit: 'input_token',
    success: true,
    sourceId: null,
    metadata: {},
    ...overrides,
  };
}

describe('usage vocabulary', () => {
  it('closes the category vocabulary', () => {
    expect(USAGE_CATEGORIES).toEqual(['ai', 'dataforseo', 'google', 'job', 'publishing', 'media']);
    expect(isValidUsageCategory('ai')).toBe(true);
    expect(isValidUsageCategory('dataforseo')).toBe(true);
    expect(isValidUsageCategory('google')).toBe(true);
    expect(isValidUsageCategory('job')).toBe(true);
    expect(isValidUsageCategory('publishing')).toBe(true);
    expect(isValidUsageCategory('media')).toBe(true);
    expect(isValidUsageCategory('billing')).toBe(false);
  });

  it('closes the unit vocabulary and keeps token directions distinct', () => {
    expect(USAGE_UNITS).toContain('input_token');
    expect(USAGE_UNITS).toContain('output_token');
    expect(USAGE_UNITS).not.toContain('token');
    expect(USAGE_UNITS).toContain('serp_request');
    expect(USAGE_UNITS).toContain('gsc_request');
    expect(USAGE_UNITS).toContain('ga4_request');
    expect(USAGE_UNITS).toContain('publish_attempt');
    expect(USAGE_UNITS).toContain('job');
    expect(isValidUsageUnit('image_generation')).toBe(true);
    expect(isValidUsageUnit('tokens')).toBe(false);
    expect(isValidUsageUnit('USD')).toBe(false);
  });

  it('requires a non-negative integer quantity', () => {
    expect(isValidUsageQuantity(0)).toBe(true);
    expect(isValidUsageQuantity(1)).toBe(true);
    expect(isValidUsageQuantity(-1)).toBe(false);
    expect(isValidUsageQuantity(1.5)).toBe(false);
    expect(isValidUsageQuantity(Number.NaN)).toBe(false);
    expect(isValidUsageQuantity(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidUsageQuantity('1')).toBe(false);
  });

  it('accepts only a plain-object metadata bag', () => {
    expect(isValidUsageMetadata({ model: 'gpt-4o-mini', retryCount: 1 })).toBe(true);
    expect(isValidUsageMetadata({})).toBe(true);
    expect(isValidUsageMetadata([])).toBe(false);
    expect(isValidUsageMetadata('nope')).toBe(false);
    expect(isValidUsageMetadata(null)).toBe(false);
  });
});

describe('usage event', () => {
  it('accepts an account/project/user-scoped AI token event', () => {
    expect(isValidUsageEvent(baseEvent())).toBe(true);
    expect(isValidUsageEvent(baseEvent({ unit: 'output_token', quantity: 42 }))).toBe(true);
    expect(isValidUsageEvent(baseEvent({ operation: 'embed', unit: 'input_token' }))).toBe(true);
  });

  it('accepts null scope for worker-originated work', () => {
    expect(isValidUsageEvent(baseEvent({ accountId: null, projectId: null, userId: null }))).toBe(true);
    expect(isValidUsageEvent(baseEvent({ userId: null }))).toBe(true);
  });

  it('represents DataForSEO SERP and GSC requests', () => {
    expect(
      isValidUsageEvent(
        baseEvent({
          category: 'dataforseo',
          provider: 'dataforseo',
          operation: 'serp_live',
          unit: 'serp_request',
          quantity: 1,
        }),
      ),
    ).toBe(true);
    expect(
      isValidUsageEvent(
        baseEvent({
          category: 'dataforseo',
          provider: 'gsc',
          operation: 'gsc_sync',
          unit: 'gsc_request',
          quantity: 25,
        }),
      ),
    ).toBe(true);
  });

  it('represents job, publishing and media consumption', () => {
    expect(
      isValidUsageEvent(
        baseEvent({
          category: 'job',
          provider: 'dataforseo',
          operation: 'keyword_research',
          unit: 'job',
          quantity: 1,
          metadata: { jobId: ID, durationMs: 1234, retryCount: 1 },
        }),
      ),
    ).toBe(true);
    expect(
      isValidUsageEvent(
        baseEvent({
          category: 'publishing',
          provider: 'wordpress',
          operation: 'publish',
          unit: 'publish_attempt',
          quantity: 1,
        }),
      ),
    ).toBe(true);
    expect(
      isValidUsageEvent(
        baseEvent({
          category: 'media',
          provider: 'openai_media',
          operation: 'image_generate',
          unit: 'image_generation',
          quantity: 1,
        }),
      ),
    ).toBe(true);
    expect(
      isValidUsageEvent(
        baseEvent({
          category: 'media',
          provider: 'unsplash',
          operation: 'media_search',
          unit: 'request',
          quantity: 1,
        }),
      ),
    ).toBe(true);
  });

  it('represents a failed attempt as a valid fact', () => {
    expect(isValidUsageEvent(baseEvent({ success: false, quantity: 0 }))).toBe(true);
    expect(isValidUsageEvent(baseEvent({ success: false, sourceId: ID }))).toBe(true);
  });

  it('rejects malformed ids, tokens and vocabularies', () => {
    expect(isValidUsageEvent(baseEvent({ id: 'not-a-uuid' }))).toBe(false);
    expect(isValidUsageEvent(baseEvent({ accountId: 'not-a-uuid' }))).toBe(false);
    expect(isValidUsageEvent(baseEvent({ provider: 'OpenAI' }))).toBe(false);
    expect(isValidUsageEvent(baseEvent({ provider: '' }))).toBe(false);
    expect(isValidUsageEvent(baseEvent({ operation: 'serp live' }))).toBe(false);
    expect(isValidUsageEvent(baseEvent({ category: 'billing' as never }))).toBe(false);
    expect(isValidUsageEvent(baseEvent({ unit: 'tok' as never }))).toBe(false);
    expect(isValidUsageEvent(baseEvent({ success: 'yes' as never }))).toBe(false);
    expect(isValidUsageEvent(baseEvent({ metadata: [] as never }))).toBe(false);
  });

  it('rejects unknown keys, missing fields and malformed dates/source ids', () => {
    expect(isValidUsageEvent({ ...baseEvent(), extra: 1 })).toBe(false);
    expect(isValidUsageEvent({ ...baseEvent(), occurredAt: '' })).toBe(false);
    expect(isValidUsageEvent(baseEvent({ sourceId: '' }))).toBe(false);
    expect(isValidUsageEvent(baseEvent({ sourceId: 'a'.repeat(201) }))).toBe(false);
    expect(isValidUsageEvent(null)).toBe(false);
    expect(isValidUsageEvent({})).toBe(false);
  });
});

describe('usage idempotency key', () => {
  const parts = {
    category: 'ai' as const,
    provider: 'openai',
    operation: 'chat',
    unit: 'input_token' as const,
    sourceId: 'call-123',
  };

  it('derives a deterministic v1 key from the stable source id', () => {
    expect(usageEventIdempotencyKey(parts)).toBe('v1|ai|openai|chat|input_token|call-123|0');
    expect(usageEventIdempotencyKey(parts)).toBe(usageEventIdempotencyKey({ ...parts }));
  });

  it('separates the two token directions for one source', () => {
    const input = usageEventIdempotencyKey(parts);
    const output = usageEventIdempotencyKey({ ...parts, unit: 'output_token' });
    expect(input).not.toBe(output);
  });

  it('disambiguates repeated facts of the same kind with occurrence', () => {
    expect(usageEventIdempotencyKey({ ...parts, occurrence: 1 })).toBe(
      'v1|ai|openai|chat|input_token|call-123|1',
    );
  });

  it('returns null without a stable source id (not deduplicatable)', () => {
    expect(usageEventIdempotencyKey({ ...parts, sourceId: null })).toBeNull();
    expect(usageEventIdempotencyKey({ ...parts, sourceId: '' })).toBeNull();
  });
});
