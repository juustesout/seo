import { describe, expect, it } from 'vitest';
import {
  computeFreshness,
  contentHash,
  DAY_MS,
  HOUR_MS,
  nextRefreshAt,
  normalizeRefreshPolicy,
  policyIntervalMs,
  refreshBackoffMs,
  type FreshnessFacts,
} from './freshness.js';

const NOW = new Date('2026-01-15T12:00:00.000Z');

function facts(overrides: Partial<FreshnessFacts> = {}): FreshnessFacts {
  return {
    sourceType: 'url',
    status: 'ready',
    refreshPolicy: 'daily',
    lastFetchedAt: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    lastChangedAt: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    nextRefreshAt: new Date(NOW.getTime() + HOUR_MS).toISOString(),
    refreshFailures: 0,
    ...overrides,
  };
}

describe('contentHash', () => {
  it('is deterministic and stable for identical text', () => {
    expect(contentHash('hello world')).toBe(contentHash('hello world'));
  });

  it('changes when any character changes', () => {
    expect(contentHash('hello world')).not.toBe(contentHash('hello worlds'));
  });

  it('is a 64-char lowercase hex sha256 digest', () => {
    expect(contentHash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('policy intervals and nextRefreshAt', () => {
  it('maps each policy to a fixed interval with monthly = 30 days', () => {
    expect(policyIntervalMs('manual')).toBeNull();
    expect(policyIntervalMs('daily')).toBe(DAY_MS);
    expect(policyIntervalMs('weekly')).toBe(7 * DAY_MS);
    expect(policyIntervalMs('monthly')).toBe(30 * DAY_MS);
    expect(policyIntervalMs(undefined)).toBeNull();
  });

  it('never schedules automatic checks for a manual policy', () => {
    expect(nextRefreshAt('manual', NOW)).toBeNull();
    expect(nextRefreshAt(null, NOW)).toBeNull();
  });

  it('schedules relative to the last successful fetch', () => {
    expect(nextRefreshAt('daily', NOW)).toBe(new Date(NOW.getTime() + DAY_MS).toISOString());
    expect(nextRefreshAt('weekly', NOW)).toBe(new Date(NOW.getTime() + 7 * DAY_MS).toISOString());
  });

  it('normalizes unknown policy values to null', () => {
    expect(normalizeRefreshPolicy('daily')).toBe('daily');
    expect(normalizeRefreshPolicy('hourly')).toBeNull();
    expect(normalizeRefreshPolicy(undefined)).toBeNull();
  });
});

describe('refreshBackoffMs (bounded)', () => {
  it('grows 1h, 6h, 24h then plateaus at one week', () => {
    expect(refreshBackoffMs(1)).toBe(HOUR_MS);
    expect(refreshBackoffMs(2)).toBe(6 * HOUR_MS);
    expect(refreshBackoffMs(3)).toBe(24 * HOUR_MS);
    expect(refreshBackoffMs(4)).toBe(7 * DAY_MS);
  });

  it('is capped and never grows unbounded for high failure counts', () => {
    for (const count of [4, 5, 50, 1000, Number.MAX_SAFE_INTEGER]) {
      expect(refreshBackoffMs(count)).toBe(7 * DAY_MS);
    }
  });

  it('treats missing or invalid counts as the first retry', () => {
    expect(refreshBackoffMs(0)).toBe(HOUR_MS);
    expect(refreshBackoffMs(-3)).toBe(HOUR_MS);
    expect(refreshBackoffMs(Number.NaN)).toBe(HOUR_MS);
  });
});

describe('computeFreshness', () => {
  it('is unknown for non-URL sources regardless of timestamps', () => {
    expect(computeFreshness(facts({ sourceType: 'text' }), NOW).state).toBe('unknown');
    expect(computeFreshness(facts({ sourceType: 'file' }), NOW).state).toBe('unknown');
  });

  it('is unknown when the URL was never fetched or is not ready', () => {
    expect(computeFreshness(facts({ lastFetchedAt: null }), NOW).state).toBe('unknown');
    expect(computeFreshness(facts({ status: 'queued' }), NOW).state).toBe('unknown');
    expect(computeFreshness(facts({ status: 'failed' }), NOW).state).toBe('unknown');
  });

  it('is fresh before next_refresh_at and due after it', () => {
    expect(computeFreshness(facts(), NOW).state).toBe('fresh');
    const due = facts({ nextRefreshAt: new Date(NOW.getTime() - HOUR_MS).toISOString() });
    expect(computeFreshness(due, NOW).state).toBe('due');
  });

  it('is stale once three policy intervals have elapsed past the due time', () => {
    const threeDaysLate = new Date(NOW.getTime() - 3 * DAY_MS - HOUR_MS).toISOString();
    expect(computeFreshness(facts({ nextRefreshAt: threeDaysLate }), NOW).state).toBe('stale');
  });

  it('treats a ready manual URL with no schedule as fresh, not unknown', () => {
    const manual = facts({ refreshPolicy: 'manual', nextRefreshAt: null });
    expect(computeFreshness(manual, NOW).state).toBe('fresh');
  });

  it('normalizes the stored policy and failure count in every result', () => {
    const dirty = computeFreshness(
      facts({ refreshPolicy: 'hourly', refreshFailures: -2.6 }),
      NOW,
    );
    expect(dirty.refresh_policy).toBeNull();
    expect(dirty.refresh_failures).toBe(0);
  });

  it('ignores an unparseable next_refresh_at instead of guessing', () => {
    expect(computeFreshness(facts({ nextRefreshAt: 'not-a-date' }), NOW).state).toBe('unknown');
  });
});
