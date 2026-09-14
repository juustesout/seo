/**
 * Canonical source-snapshot scopes (KW4.5 foundation).
 *
 * The single rule: the canonical scope contains every parameter that can change
 * the *substantive* provider result, and nothing else - never a jobId, userId
 * or timestamp. Two requests that could yield a different answer must produce a
 * different scope (and therefore a different snapshot); two requests that must
 * yield the same answer must produce the same scope.
 *
 * `scopeKeyOf` hashes a deterministic, key-sorted serialization so scope
 * matching never depends on JSON.stringify insertion order. Order-insensitive
 * fields (the competitor set) are normalized here, before hashing, so array
 * order can never split one logical scope into two.
 */

import { createHash } from 'node:crypto';
import {
  COMPETITOR_GAP_MAX_RANK,
  COMPETITOR_GAP_MIN_SEARCH_VOLUME,
  COMPETITOR_RESEARCH_MAX_CANDIDATES,
  COMPETITOR_RESEARCH_RUN_MAX_GAPS,
} from '@seo/contracts';
import { DATAFORSEO_LANGUAGE_CODE, DATAFORSEO_LOCATION_CODE } from '../providers/dataforseo/market.js';
import { normalizeDomain } from './domain.js';

/** Deterministic JSON: object keys sorted, `undefined` values dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** Stable snapshot identity for a canonical scope: SHA-256 (hex) of its JSON. */
export function scopeKeyOf(scope: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(scope)).digest('hex');
}

/** The canonical scope of a competitor-discovery snapshot. */
export function competitorDiscoveryScope(input: {
  domain: string;
  limit?: number;
}): Record<string, unknown> {
  return {
    provider: 'dataforseo',
    domain: normalizeDomain(input.domain),
    location_code: DATAFORSEO_LOCATION_CODE,
    language_code: DATAFORSEO_LANGUAGE_CODE,
    limit: input.limit ?? COMPETITOR_RESEARCH_MAX_CANDIDATES,
    exclude_top_domains: true,
  };
}

/** The canonical scope of a competitor keyword-gap snapshot. */
export function competitorGapScope(input: {
  domain: string;
  competitors: string[];
  minSearchVolume?: number;
  maxRank?: number;
  limitPerCompetitor?: number;
}): Record<string, unknown> {
  const competitors = [...new Set(input.competitors.map(normalizeDomain).filter(Boolean))].sort();
  return {
    provider: 'dataforseo',
    domain: normalizeDomain(input.domain),
    competitors,
    location_code: DATAFORSEO_LOCATION_CODE,
    language_code: DATAFORSEO_LANGUAGE_CODE,
    min_search_volume: input.minSearchVolume ?? COMPETITOR_GAP_MIN_SEARCH_VOLUME,
    max_rank_group: input.maxRank ?? COMPETITOR_GAP_MAX_RANK,
    item_types: ['organic'],
    limit_per_competitor: input.limitPerCompetitor ?? COMPETITOR_RESEARCH_RUN_MAX_GAPS,
  };
}
