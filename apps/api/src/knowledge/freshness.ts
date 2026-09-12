/**
 * Knowledge freshness & refresh lifecycle (KB7).
 *
 * This module is the single, deterministic owner of three derived rules that
 * must never be re-implemented in a route or the UI:
 *
 *   1. `contentHash`      - SHA-256 of the normalized, capped body. Only the
 *                           canonical text that reaches the knowledge base is
 *                           hashed (never a raw HTTP body, HTML or headers).
 *   2. `nextRefreshAt`    - the scheduled check time for a policy, always
 *                           relative to the last successful fetch.
 *   3. `computeFreshness` - the derived fresh/due/stale/unknown state.
 *
 * Postgres stores facts (timestamps, hash, failure count, policy); the state is
 * recomputed from them on every read so it can never drift.
 */

import { createHash } from 'node:crypto';
import type {
  KnowledgeFreshnessDto,
  KnowledgeFreshnessState,
  KnowledgeRefreshPolicy,
  KnowledgeSourceStatus,
  KnowledgeSourceType,
} from '@seo/contracts';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** Interval between scheduled checks per policy; `manual` never schedules. */
const POLICY_INTERVAL_MS: Record<KnowledgeRefreshPolicy, number | null> = {
  manual: null,
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
};

/**
 * How many intervals past `next_refresh_at` before a source is reported as
 * `stale` rather than merely `due`. Bounded and policy-relative so a daily
 * source is stale after 3 days, a weekly one after 3 weeks.
 */
export const STALE_INTERVAL_FACTOR = 3;

/**
 * Bounded refresh backoff. Never unbounded exponential growth: the retry delay
 * grows with the consecutive-failure count and then plateaus at one week.
 */
const BACKOFF_MS: readonly number[] = [HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS, 7 * DAY_MS];

/** Delay until the next automatic refresh attempt for `failures` failures. */
export function refreshBackoffMs(failures: number): number {
  const count = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : 1;
  return BACKOFF_MS[Math.min(count, BACKOFF_MS.length) - 1]!;
}

/** The interval a policy schedules between checks, or null for manual. */
export function policyIntervalMs(policy: KnowledgeRefreshPolicy | null | undefined): number | null {
  if (!policy) return null;
  return POLICY_INTERVAL_MS[policy] ?? null;
}

/** Coerce stored/request text to a canonical policy, or null when unknown. */
export function normalizeRefreshPolicy(value: unknown): KnowledgeRefreshPolicy | null {
  return value === 'manual' || value === 'daily' || value === 'weekly' || value === 'monthly' ? value : null;
}

/**
 * The next scheduled check after a successful fetch under `policy`, or null for
 * manual (never auto-refresh). Uses fixed intervals for determinism (monthly is
 * 30 days), matching the documented policy semantics.
 */
export function nextRefreshAt(policy: KnowledgeRefreshPolicy | null | undefined, from: Date): string | null {
  const interval = policyIntervalMs(policy);
  if (interval == null) return null;
  return new Date(from.getTime() + interval).toISOString();
}

/** SHA-256 (hex) of the canonical indexed text. Never a raw body or header. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Facts a freshness calculation reads; all come from the registry row. */
export interface FreshnessFacts {
  sourceType: KnowledgeSourceType;
  status: KnowledgeSourceStatus;
  refreshPolicy: unknown;
  lastFetchedAt: string | null;
  lastChangedAt: string | null;
  nextRefreshAt: string | null;
  refreshFailures: number;
}

/**
 * Derive the freshness state from stored facts. Freshness is a separate
 * dimension from lifecycle: a `ready` source with a successful fetch is always
 * fresh/due/stale, never one of those if it was never fetched.
 */
export function computeFreshness(facts: FreshnessFacts, now: Date = new Date()): KnowledgeFreshnessDto {
  const policy = normalizeRefreshPolicy(facts.refreshPolicy);
  const base: KnowledgeFreshnessDto = {
    state: 'unknown',
    refresh_policy: policy,
    last_fetched_at: facts.lastFetchedAt,
    last_changed_at: facts.lastChangedAt,
    next_refresh_at: facts.nextRefreshAt,
    refresh_failures: Number.isFinite(facts.refreshFailures) ? Math.max(0, Math.floor(facts.refreshFailures)) : 0,
  };

  if (facts.sourceType !== 'url') return base;
  if (facts.status !== 'ready' || !facts.lastFetchedAt) return base;
  if (!facts.nextRefreshAt) return { ...base, state: 'fresh' };

  const next = Date.parse(facts.nextRefreshAt);
  if (!Number.isFinite(next)) return base;

  if (now.getTime() < next) return { ...base, state: 'fresh' };
  const interval = policyIntervalMs(policy) ?? 0;
  const staleAt = next + interval * STALE_INTERVAL_FACTOR;
  const state: KnowledgeFreshnessState = now.getTime() >= staleAt ? 'stale' : 'due';
  return { ...base, state };
}
