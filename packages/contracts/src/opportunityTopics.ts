/**
 * Topic recommendations (KW6) - the conclusion layer on top of the KW5.1
 * opportunity projection.
 *
 * The flow is `gap opportunities -> core-topic relevance -> knowledge readiness
 * -> a small set of actionable recommendations`. It is deliberately a pure,
 * read-only projection: no provider call, no new persistence, no LLM and no new
 * vector collection. Relevance is a ranking signal only - it is never surfaced
 * as a calibrated percentage.
 */

import type { OpportunityCompetitorDto, OpportunityIntent, OpportunityReason, OpportunitySnapshotMetaDto } from './api.js';

// ---------------------------------------------------------------------------
// Core topics (stored in seo_projects.settings.coreTopics, no new table)
// ---------------------------------------------------------------------------

/** Maximum number of core topics a project may keep. */
export const CORE_TOPICS_MAX = 50;

/** Bounds for one core topic's free text and keyword hints. */
export const CORE_TOPIC_NAME_MAX_CHARS = 120;
export const CORE_TOPIC_DESCRIPTION_MAX_CHARS = 500;
export const CORE_TOPIC_KEYWORDS_MAX = 20;
export const CORE_TOPIC_KEYWORD_MAX_CHARS = 80;

/**
 * One campaign/core topic. `description` participates in matching because it
 * carries the semantic context a bare name lacks; `keywords` are optional
 * hints that widen the topic text.
 */
export interface CoreTopicDto {
  name: string;
  description: string;
  keywords?: string[];
}

/** The project's stored core topics. */
export interface CoreTopicsDto {
  topics: CoreTopicDto[];
}

// ---------------------------------------------------------------------------
// Topic relevance / knowledge readiness
// ---------------------------------------------------------------------------

/**
 * Relevance is reported as a coarse state, never a percentage: cosine
 * similarity is a ranking signal, not a calibrated probability.
 */
export const TOPIC_RELEVANCE_STATES = ['strong', 'moderate', 'weak', 'no_match'] as const;
export type TopicRelevanceState = (typeof TOPIC_RELEVANCE_STATES)[number];

/** How much usable knowledge the project already holds for a topic. */
export const KNOWLEDGE_READINESS_STATES = ['strong', 'moderate', 'weak', 'none'] as const;
export type KnowledgeReadinessState = (typeof KNOWLEDGE_READINESS_STATES)[number];

/** The two actions KW6 can recommend. Neither is ever executed automatically. */
export const TOPIC_ACTION_KINDS = ['research', 'create_article'] as const;
export type TopicActionKind = (typeof TOPIC_ACTION_KINDS)[number];

export interface TopicRelevanceDto {
  state: TopicRelevanceState;
  /**
   * Raw relevance ranking score (0..1). Diagnostic only - never rendered as a
   * percentage. It is a similarity/ranking value with no probabilistic meaning.
   */
  score?: number;
}

export interface TopicKnowledgeReadinessDto {
  state: KnowledgeReadinessState;
  /** Distinct knowledge sources that matched (managed sources + system index). */
  sources: number;
  /** Strongest retrieval ranking score among the hits, when any. */
  topScore?: number;
  /** Honest, short explanation when a state needs one (e.g. not configured). */
  note?: string;
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

/** One opportunity keyword as it belongs to a recommended topic. */
export interface TopicOpportunityKeywordDto {
  keyword: string;
  volume: number | null;
  opportunityScore: number;
  competitors: OpportunityCompetitorDto[];
}

/**
 * One actionable topic recommendation. It carries the useful keywords rather
 * than a bare label, plus the evidence behind the recommendation so the UI can
 * explain "why".
 */
export interface TopicRecommendationDto {
  topic: {
    name: string;
    description: string;
  };
  relevance: TopicRelevanceDto;
  knowledge: TopicKnowledgeReadinessDto;
  /** The strongest matching opportunity keywords (canonical labels). */
  keywords: TopicOpportunityKeywordDto[];
  /** How many opportunity rows were assigned to this topic before trimming. */
  candidateCount: number;
  totalVolume: number;
  bestOpportunityScore: number;
  /** Best (lowest) competitor rank per domain across the topic's keywords. */
  competitorEvidence: OpportunityCompetitorDto[];
  recommendation: TopicActionKind;
  /**
   * False when the recommended action has no safe existing entry point yet.
   * Pre-write research is currently such a case: the UI must not fake it.
   */
  actionAvailable: boolean;
  /** One short deterministic explanation for the recommendation. */
  why: string;
}

/** Result of one topic-recommendation read over the exact competitor set. */
export interface TopicRecommendationsDto {
  /** The current-best-known gap snapshot, or null when none exists yet. */
  snapshot: OpportunitySnapshotMetaDto | null;
  recommendations: TopicRecommendationDto[];
  /** Opportunity rows considered (before topic assignment). */
  consideredCount: number;
  /** Viable topic candidates before the bounded knowledge search. */
  candidateCount: number;
  /** True when knowledge retrieval is configured on this server. */
  knowledgeConfigured: boolean;
  /** True when the project has at least one core topic configured. */
  topicsConfigured: boolean;
}

// ---------------------------------------------------------------------------
// Create-article hand-off (shared Writer Engine via the content_write job)
// ---------------------------------------------------------------------------

/** The topic context sent when the user turns a recommendation into a draft. */
export interface TopicArticleRequest {
  topic_name: string;
  topic_description: string;
  primary_keyword?: string | null;
  keywords?: Array<{ keyword: string; volume: number | null }>;
  competitors?: OpportunityCompetitorDto[];
  opportunity_score?: number | null;
  /** Deterministic reason tags behind the score, when the UI has them. */
  reasons?: OpportunityReason[];
  /** Observed keyword difficulty (0..100), when the UI has it. */
  difficulty?: number | null;
  /** Deterministic lexical intent, when the UI has it. */
  intent?: OpportunityIntent | null;
}

/** Bounds for the structured opportunity context handed to the writer. */
export const TOPIC_ARTICLE_MAX_KEYWORDS = 20;
export const TOPIC_ARTICLE_MAX_COMPETITORS = 3;

/** Default number of topic actions shown; the API can return a few more. */
export const TOPIC_DEFAULT_RECOMMENDATIONS = 3;

/** Hard cap on topic recommendations returned in one response. */
export const TOPIC_MAX_RECOMMENDATIONS = 5;

/** Maximum viable topic candidates that receive a bounded knowledge search. */
export const TOPIC_CANDIDATE_LIMIT = 10;
