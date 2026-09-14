/**
 * Deterministic keyword canonicalization and intent classification (KW5 v1).
 *
 * Competitor gap snapshots often carry the same concept under several
 * spellings ("front end newsletter", "front-end newsletter", "frontend
 * newsletter"). This module folds those into one comparison key so opportunity
 * analysis can consolidate them without inventing meaning: no stemming, no
 * synonyms, no embeddings. Every original spelling is preserved by the caller
 * as provenance.
 *
 * `classifyIntent` is a small, explicit word-list heuristic run over the
 * keyword text. It is a deterministic convenience signal for filtering, never
 * a provider metric and never an LLM judgement; an unmatched keyword stays
 * null rather than being guessed.
 */

import type { OpportunityIntent } from '@seo/contracts';

/**
 * Fold a keyword to a comparison key: Unicode NFKC, lowercase, then drop the
 * separators that only encode spelling (whitespace, hyphen, underscore,
 * apostrophes). "front end newsletter", "front-end newsletter" and
 * "frontend newsletter" all collapse to `frontendnewsletter`. Meaningful
 * punctuation such as `+`/`#` is kept, so `c++` and `c#` stay distinct.
 */
export function canonicalKeywordKey(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_'\u2018\u2019]+/g, '');
}

/** One spelling and how many gap rows used it. */
export interface KeywordVariantCount {
  value: string;
  count: number;
}

/**
 * Pick the display spelling for a consolidated keyword, deterministically:
 * most frequent spelling first, then the spelling with fewer separators, then
 * the shorter one, then lexicographic. Ties are broken without randomness so
 * the same snapshot always yields the same label.
 */
export function chooseCanonicalLabel(variants: KeywordVariantCount[]): string {
  const separatorCount = (value: string) => (value.match(/[\s\-_]/g) ?? []).length;
  const sorted = [...variants].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const sepA = separatorCount(a.value);
    const sepB = separatorCount(b.value);
    if (sepA !== sepB) return sepA - sepB;
    if (a.value.length !== b.value.length) return a.value.length - b.value.length;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });
  return sorted[0]!.value;
}

const TRANSACTIONAL_WORDS = new Set([
  'buy',
  'order',
  'deal',
  'deals',
  'coupon',
  'coupons',
  'discount',
  'discounts',
  'cheap',
  'pricing',
  'price',
  'prices',
  'sale',
  'shop',
  'purchase',
  'subscribe',
  'subscription',
]);

const COMMERCIAL_WORDS = new Set([
  'best',
  'top',
  'review',
  'reviews',
  'vs',
  'versus',
  'compare',
  'comparison',
  'alternative',
  'alternatives',
  'recommended',
]);

const INFORMATIONAL_WORDS = new Set([
  'how',
  'what',
  'why',
  'when',
  'where',
  'who',
  'guide',
  'tutorial',
  'tutorials',
  'tips',
  'learn',
  'examples',
  'meaning',
  'definition',
]);

/** Split a keyword into lowercase alphanumeric tokens for the word lists. */
function tokensOf(raw: string): string[] {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Classify a keyword's likely intent from explicit signal words, most
 * actionable first (transactional, then commercial, then informational). A
 * keyword that matches none stays null - the caller must not fabricate one.
 */
export function classifyIntent(raw: string): OpportunityIntent | null {
  const tokens = tokensOf(raw);
  if (tokens.some((token) => TRANSACTIONAL_WORDS.has(token))) return 'transactional';
  if (tokens.some((token) => COMMERCIAL_WORDS.has(token))) return 'commercial';
  if (tokens.some((token) => INFORMATIONAL_WORDS.has(token))) return 'informational';
  return null;
}
