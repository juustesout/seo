/**
 * Topic recommendation scoring (KW6).
 *
 * Pure, deterministic helpers for the topics layer: similarity -> coarse
 * relevance state, retrieval hits -> knowledge readiness state, and a small
 * weighted ranking used to pick the final few actions. Thresholds live here and
 * nowhere else so they can be tuned in one place later.
 *
 * A similarity score is a ranking signal, never a calibrated probability. The
 * states below deliberately map scores to coarse buckets so the UI can never
 * show a fabricated "82% relevant".
 */

import type {
  KnowledgeReadinessState,
  TopicActionKind,
  TopicRelevanceState,
} from '@seo/contracts';

/** How the pairwise relevance score was produced. */
export type RelevanceOrigin = 'embedding' | 'lexical';

/**
 * Cosine thresholds for embedding similarity. Cosine of two text-embedding
 * vectors sits in a high band even for loosely related text, so "strong" starts
 * well above the 0.5 midpoint.
 */
export const EMBEDDING_RELEVANCE_THRESHOLDS = {
  strong: 0.55,
  moderate: 0.45,
  weak: 0.35,
} as const;

/**
 * Coverage thresholds for the deterministic lexical fallback (share of the
 * topic's significant tokens present in the keyword). Used only when no
 * embedder is configured.
 */
export const LEXICAL_RELEVANCE_THRESHOLDS = {
  strong: 0.6,
  moderate: 0.34,
  weak: 0.2,
} as const;

/** Distinct-source / hit-count thresholds that derive knowledge readiness. */
export const KNOWLEDGE_READINESS_THRESHOLDS = {
  /** At least this many distinct sources is strong on its own. */
  strongSources: 3,
  /** Two sources with at least this many hits is also strong. */
  strongSourcesWithHits: 2,
  strongHits: 6,
  /** Two distinct sources (or this many hits) is at least moderate. */
  moderateSources: 2,
  moderateHits: 3,
} as const;

/** A recommendation needs at least this opportunity score to be "meaningful". */
export const MEANINGFUL_OPPORTUNITY_SCORE = 35;

/** ...or at least this combined search volume. */
export const MEANINGFUL_OPPORTUNITY_VOLUME = 100;

/** Weighted ranking of a topic candidate before knowledge readiness is known. */
const RELEVANCE_WEIGHT = 0.4;
const OPPORTUNITY_WEIGHT = 0.3;
const VOLUME_WEIGHT = 0.2;
const COMPETITOR_WEIGHT = 0.1;

/** Weight of the pre-knowledge ranking vs readiness in the final order. */
const CANDIDATE_RANK_WEIGHT = 0.75;
const READINESS_RANK_WEIGHT = 0.25;

/** Volume at/above which the logarithmic volume component saturates. */
const VOLUME_CEILING = 100_000;

/** Unique competitors at/above which the competitor component saturates. */
const COMPETITOR_CAP = 3;

/** Relative weight of each readiness state in the final ranking. */
const READINESS_RANK: Record<KnowledgeReadinessState, number> = {
  strong: 1,
  moderate: 0.7,
  weak: 0.3,
  none: 0,
};

/** Clamp a number to the 0..1 range. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Logarithmically normalize a positive value against a ceiling into 0..1. */
function logScore(value: number, ceiling: number): number {
  if (!(value > 0)) return 0;
  return clamp01(Math.log10(value + 1) / Math.log10(ceiling + 1));
}

/** Cosine similarity of two equal-length vectors (0 when either is degenerate). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return clamp01(dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

/** Map a raw relevance score to its coarse state for the given origin. */
export function relevanceState(score: number, origin: RelevanceOrigin): TopicRelevanceState {
  const thresholds = origin === 'embedding' ? EMBEDDING_RELEVANCE_THRESHOLDS : LEXICAL_RELEVANCE_THRESHOLDS;
  if (!Number.isFinite(score)) return 'no_match';
  if (score >= thresholds.strong) return 'strong';
  if (score >= thresholds.moderate) return 'moderate';
  if (score >= thresholds.weak) return 'weak';
  return 'no_match';
}

/** The subset of a retrieval hit the readiness rule needs. */
export interface ReadinessHit {
  source_id: string;
  score: number;
}

/**
 * Derive knowledge readiness from existing retrieval hits. Only signals the
 * retrieval pipeline already returns are used: distinct sources and hit count.
 * A retrieval score is a ranking signal, so it informs `topScore` but never
 * turns into a percentage.
 */
export function knowledgeReadinessState(hits: ReadonlyArray<ReadinessHit>): KnowledgeReadinessState {
  const results = hits.length;
  if (results === 0) return 'none';
  const sources = new Set(hits.map((hit) => hit.source_id)).size;
  if (sources === 0) return 'none';
  const t = KNOWLEDGE_READINESS_THRESHOLDS;
  if (sources >= t.strongSources || (sources >= t.strongSourcesWithHits && results >= t.strongHits)) {
    return 'strong';
  }
  if (sources >= t.moderateSources || results >= t.moderateHits) return 'moderate';
  return 'weak';
}

/** Facts that rank a topic candidate before knowledge readiness is known. */
export interface TopicCandidateFacts {
  relevanceScore: number;
  bestOpportunityScore: number;
  totalVolume: number;
  competitorCount: number;
}

/** Weighted 0..1 rank for a topic candidate (higher is better). */
export function candidateRank(facts: TopicCandidateFacts): number {
  const relevance = clamp01(facts.relevanceScore);
  const opportunity = clamp01(facts.bestOpportunityScore / 100);
  const volume = logScore(facts.totalVolume, VOLUME_CEILING);
  const competitors = clamp01(Math.min(Math.max(facts.competitorCount, 0), COMPETITOR_CAP) / COMPETITOR_CAP);
  return (
    relevance * RELEVANCE_WEIGHT +
    opportunity * OPPORTUNITY_WEIGHT +
    volume * VOLUME_WEIGHT +
    competitors * COMPETITOR_WEIGHT
  );
}

/** Final rank: the pre-knowledge rank blended with knowledge readiness. */
export function recommendationRank(facts: TopicCandidateFacts, readiness: KnowledgeReadinessState): number {
  return candidateRank(facts) * CANDIDATE_RANK_WEIGHT + READINESS_RANK[readiness] * READINESS_RANK_WEIGHT;
}

/** Whether an opportunity is meaningful enough to act on. */
export function isMeaningfulOpportunity(bestOpportunityScore: number, totalVolume: number): boolean {
  return (
    bestOpportunityScore >= MEANINGFUL_OPPORTUNITY_SCORE || totalVolume >= MEANINGFUL_OPPORTUNITY_VOLUME
  );
}

/**
 * Decide Research vs Create article, or null when the candidate is not
 * actionable (weak relevance or a thin opportunity).
 *
 *   Create article - relevant, meaningful, and enough knowledge already exists.
 *   Research       - relevant and valuable, but the knowledge base is thin.
 *
 * The recommendation is advice only; nothing is executed here.
 */
export function decideRecommendation(input: {
  relevance: TopicRelevanceState;
  readiness: KnowledgeReadinessState;
  bestOpportunityScore: number;
  totalVolume: number;
}): TopicActionKind | null {
  if (input.relevance !== 'strong' && input.relevance !== 'moderate') return null;
  if (!isMeaningfulOpportunity(input.bestOpportunityScore, input.totalVolume)) return null;
  if (input.readiness === 'strong' || input.readiness === 'moderate') return 'create_article';
  return 'research';
}
