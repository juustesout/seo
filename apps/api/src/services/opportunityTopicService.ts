/**
 * Opportunity topic recommendations (KW6).
 *
 * The conclusion layer of the keyword workflow. It reuses the KW5.1
 * opportunity projection and turns up to 200 gap keywords into a handful of
 * actionable topics:
 *
 *   gap opportunities -> core-topic relevance -> knowledge readiness -> top actions
 *
 * Design rules (from the KW6 recon):
 *   - core topics live in `seo_projects.settings.coreTopics` (no new table);
 *   - relevance prefers the existing embedding infrastructure, and degrades to
 *     the deterministic lexical helper when no embedder is configured;
 *   - similarity is reported as a coarse state, never a percentage;
 *   - knowledge readiness reuses `KnowledgeService.search` for at most the
 *     strongest few candidates (never all 200);
 *   - research vs create article is decided deterministically, and nothing is
 *     executed automatically.
 *
 * This module never calls DataForSEO, never writes a derived result and never
 * creates a Qdrant collection. It stays out of `opportunityService` so the
 * KW5.1 projection keeps its single responsibility.
 */

import {
  CORE_TOPICS_MAX,
  CORE_TOPIC_DESCRIPTION_MAX_CHARS,
  CORE_TOPIC_KEYWORD_MAX_CHARS,
  CORE_TOPIC_KEYWORDS_MAX,
  CORE_TOPIC_NAME_MAX_CHARS,
  TOPIC_CANDIDATE_LIMIT,
  TOPIC_MAX_RECOMMENDATIONS,
  type CoreTopicDto,
  type KeywordOpportunityDto,
  type KnowledgeReadinessState,
  type OpportunityCompetitorDto,
  type TopicArticleRequest,
  type TopicOpportunityKeywordDto,
  type TopicRecommendationDto,
  type TopicRecommendationsDto,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { embedderFromConfig, type Embedder } from '../providers/knowledge/embedding.js';
import { KnowledgeService } from './knowledgeService.js';
import { canonicalKeywordKey } from './keywordCanonical.js';
import { significantTokens } from './contentIntelligence.js';
import { getOpportunities } from './opportunityService.js';
import {
  candidateRank,
  cosineSimilarity,
  decideRecommendation,
  knowledgeReadinessState,
  recommendationRank,
  relevanceState,
  type RelevanceOrigin,
  type TopicCandidateFacts,
} from './topicScoring.js';

/** How many retrieval hits the bounded readiness search may return. */
const KNOWLEDGE_READINESS_SEARCH_LIMIT = 8;

/** Longest topic query sent to the knowledge search (well under the 1000 cap). */
const KNOWLEDGE_QUERY_MAX_CHARS = 300;

/** Keyword count used to build the readiness query. */
const KNOWLEDGE_QUERY_KEYWORDS = 5;

/** How many keywords are kept on a recommendation for display/context. */
const RECOMMENDATION_KEYWORDS_MAX = 8;

/** The strengths a keyword needs to belong to a topic. */
const ASSIGNABLE_STATES = new Set(['strong', 'moderate', 'weak']);

/** Injectable seams so tests can run without a real embedder or Qdrant. */
export interface TopicRecommendationDeps {
  /** `null` forces the deterministic lexical fallback. */
  embedder?: Embedder | null;
  /** Replaces the project knowledge search (used by tests). */
  search?: (projectId: string, input: { query: string; limit?: number }) => Promise<{
    results: Array<{ source_id: string; score: number }>;
  }>;
}

// ---------------------------------------------------------------------------
// Core topics (project settings)
// ---------------------------------------------------------------------------

/** Trim, bound and de-duplicate one core topic's stored shape. */
function normalizeCoreTopic(raw: unknown): CoreTopicDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, CORE_TOPIC_NAME_MAX_CHARS) : '';
  if (!name) return null;
  const description =
    typeof record.description === 'string' ? record.description.trim().slice(0, CORE_TOPIC_DESCRIPTION_MAX_CHARS) : '';
  const keywords: string[] = [];
  if (Array.isArray(record.keywords)) {
    for (const value of record.keywords) {
      if (typeof value !== 'string') continue;
      const keyword = value.trim().slice(0, CORE_TOPIC_KEYWORD_MAX_CHARS);
      if (keyword && !keywords.includes(keyword)) keywords.push(keyword);
      if (keywords.length >= CORE_TOPIC_KEYWORDS_MAX) break;
    }
  }
  return keywords.length > 0 ? { name, description, keywords } : { name, description };
}

/**
 * Read the project's core topics from `seo_projects.settings.coreTopics`.
 * Invalid entries are dropped rather than guessed; the list is capped. A
 * missing/absent list is an honest empty list, never an error.
 */
export function parseCoreTopics(value: unknown): CoreTopicDto[] {
  if (!Array.isArray(value)) return [];
  const out: CoreTopicDto[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= CORE_TOPICS_MAX) break;
    const topic = normalizeCoreTopic(raw);
    if (!topic) continue;
    const key = canonicalKeywordKey(topic.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(topic);
  }
  return out;
}

async function readProjectSettings(
  container: ServiceContainer,
  projectId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await container.sb
    .from('seo_projects')
    .select('settings')
    .eq('id', projectId)
    .maybeSingle<{ settings: Record<string, unknown> | null }>();
  if (error) throw new ApiError(500, 'storage_error', 'Could not read the project settings');
  if (!data) throw ApiError.notFound('Project not found');
  return data.settings ?? {};
}

/** Read the project's stored core topics (empty list when none are set). */
export async function readCoreTopics(container: ServiceContainer, projectId: string): Promise<CoreTopicDto[]> {
  const settings = await readProjectSettings(container, projectId);
  return parseCoreTopics(settings.coreTopics);
}

/** Replace the project's core topics, preserving every other settings key. */
export async function writeCoreTopics(
  container: ServiceContainer,
  projectId: string,
  topics: CoreTopicDto[],
): Promise<CoreTopicDto[]> {
  const settings = await readProjectSettings(container, projectId);
  const normalized = parseCoreTopics(topics);
  const { error } = await container.sb
    .from('seo_projects')
    .update({ settings: { ...settings, coreTopics: normalized } } as never)
    .eq('id', projectId);
  if (error) throw new ApiError(400, 'bad_request', 'Could not update the project core topics');
  return normalized;
}

// ---------------------------------------------------------------------------
// Relevance
// ---------------------------------------------------------------------------

/** The text a topic is matched on: name + description + optional keyword hints. */
export function topicText(topic: CoreTopicDto): string {
  return [topic.name, topic.description, ...(topic.keywords ?? [])].filter(Boolean).join(' ');
}

/** The text an opportunity is matched on: canonical keyword + every variant. */
function opportunityText(opportunity: { keyword: string; variants: string[] }): string {
  const parts = [opportunity.keyword, ...opportunity.variants];
  return [...new Set(parts.filter((value) => typeof value === 'string' && value.length > 0))].join(' ');
}

/**
 * Deterministic lexical relevance: the share of the topic's significant tokens
 * that appear in the keyword text. Used only when no embedder is configured.
 */
export function lexicalRelevance(topic: string, keywordText: string): number {
  const topicTokens = new Set(significantTokens(topic));
  if (topicTokens.size === 0) return 0;
  const keywordTokens = new Set(significantTokens(keywordText));
  let hits = 0;
  for (const token of topicTokens) if (keywordTokens.has(token)) hits += 1;
  return hits / topicTokens.size;
}

interface PairScores {
  origin: RelevanceOrigin;
  /** score[topicIndex][opportunityIndex] */
  matrix: number[][];
}

/** Build the full topic x opportunity similarity matrix in one batch. */
async function buildPairScores(
  topics: CoreTopicDto[],
  opportunities: Array<{ keyword: string; variants: string[] }>,
  embedder: Embedder | null,
): Promise<PairScores> {
  const topicTexts = topics.map(topicText);
  const keywordTexts = opportunities.map(opportunityText);

  if (embedder) {
    try {
      const vectors = await embedder.embed([...topicTexts, ...keywordTexts]);
      if (vectors.length === topicTexts.length + keywordTexts.length) {
        const matrix = topics.map((_topic, ti) => {
          const topicVector = vectors[ti]!;
          return opportunities.map((_opp, oi) => cosineSimilarity(topicVector, vectors[topicTexts.length + oi]!));
        });
        return { origin: 'embedding', matrix };
      }
    } catch {
      // Fall through to the deterministic lexical path rather than failing the
      // whole read: relevance is advisory, not a hard dependency.
    }
  }

  const matrix = topicTexts.map((text) => keywordTexts.map((keyword) => lexicalRelevance(text, keyword)));
  return { origin: 'lexical', matrix };
}

// ---------------------------------------------------------------------------
// Readiness and recommendation assembly
// ---------------------------------------------------------------------------

/** The best (lowest) rank per domain across a set of keyword opportunities. */
function aggregateCompetitorEvidence(
  opportunities: Array<{ competitors: OpportunityCompetitorDto[] }>,
): OpportunityCompetitorDto[] {
  const best = new Map<string, number | null>();
  for (const opportunity of opportunities) {
    for (const competitor of opportunity.competitors) {
      const existing = best.get(competitor.domain);
      if (existing === undefined) {
        best.set(competitor.domain, competitor.rank);
      } else if (competitor.rank != null && (existing == null || competitor.rank < existing)) {
        best.set(competitor.domain, competitor.rank);
      }
    }
  }
  return [...best.entries()]
    .map(([domain, rank]) => ({ domain, rank }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
}

/** One short, deterministic explanation for a recommendation. */
function buildWhy(input: {
  keywordCount: number;
  totalVolume: number;
  competitorCount: number;
  relevance: string;
  readiness: KnowledgeReadinessState;
  recommendation: 'research' | 'create_article';
}): string {
  const keywords = `${input.keywordCount} matching gap keyword${input.keywordCount === 1 ? '' : 's'}`;
  const volume = input.totalVolume > 0 ? ` with about ${input.totalVolume} monthly searches combined` : '';
  const competitors =
    input.competitorCount > 0
      ? `; ${input.competitorCount} competitor${input.competitorCount === 1 ? '' : 's'} rank for related terms`
      : '';
  const relevance = `Topic relevance is ${input.relevance}.`;
  const readiness =
    input.recommendation === 'create_article'
      ? ` Existing knowledge (${input.readiness}) is enough to start a draft.`
      : ` Knowledge readiness is ${input.readiness}, so strengthen the knowledge base first.`;
  return `${keywords}${volume}${competitors}. ${relevance}${readiness}`;
}

/** Build the bounded knowledge query for one topic candidate. */
function buildKnowledgeQuery(name: string, description: string, keywords: string[]): string {
  return [name, description, ...keywords.slice(0, KNOWLEDGE_QUERY_KEYWORDS)]
    .filter(Boolean)
    .join(' ')
    .slice(0, KNOWLEDGE_QUERY_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Read the exact competitor-set gap snapshot, assign its opportunities to the
 * project's core topics, derive knowledge readiness for the strongest few
 * candidates and return bounded, deterministic recommendations.
 */
export async function getTopicRecommendations(
  container: ServiceContainer,
  projectId: string,
  competitors: string[],
  domain?: string,
  deps: TopicRecommendationDeps = {},
): Promise<TopicRecommendationsDto> {
  const topics = await readCoreTopics(container, projectId);
  const embedder =
    'embedder' in deps
      ? deps.embedder ?? null
      : embedderFromConfig({
          EMBEDDINGS_API_KEY: process.env.EMBEDDINGS_API_KEY,
          EMBEDDINGS_BASE_URL: process.env.EMBEDDINGS_BASE_URL,
          EMBEDDINGS_MODEL: process.env.EMBEDDINGS_MODEL,
          EMBEDDINGS_DIMENSIONS: process.env.EMBEDDINGS_DIMENSIONS,
          OPENAI_API_KEY: container.config.env.OPENAI_API_KEY,
          OPENAI_BASE_URL: container.config.env.OPENAI_BASE_URL,
          OPENAI_EMBEDDING_MODEL: container.config.env.OPENAI_EMBEDDING_MODEL,
        });

  const knowledgeService = new KnowledgeService(container);
  const searchFn =
    deps.search ??
    ((pid: string, input: { query: string; limit?: number }) => knowledgeService.search(pid, input));
  let knowledgeConfigured = true;
  if (!deps.search) {
    try {
      knowledgeConfigured = !knowledgeService.configuredReason();
    } catch {
      knowledgeConfigured = false;
    }
  }

  if (topics.length === 0) {
    return {
      snapshot: null,
      recommendations: [],
      consideredCount: 0,
      candidateCount: 0,
      knowledgeConfigured,
      topicsConfigured: false,
    };
  }

  const opportunitiesDto = await getOpportunities(
    container,
    projectId,
    competitors,
    { limit: 200 },
    domain,
  );
  if (!opportunitiesDto.snapshot) {
    return {
      snapshot: null,
      recommendations: [],
      consideredCount: 0,
      candidateCount: 0,
      knowledgeConfigured,
      topicsConfigured: true,
    };
  }

  const opportunities = opportunitiesDto.opportunities;
  const { origin, matrix } = await buildPairScores(topics, opportunities, embedder);

  // Assign each opportunity to its single best-matching topic, dropping any
  // pairing that does not clear the weakest relevance state. The per-topic best
  // score is tracked during the same pass.
  const assigned: KeywordOpportunityDto[][] = topics.map(() => []);
  const bestByTopic: number[] = topics.map(() => -1);
  for (let oi = 0; oi < opportunities.length; oi += 1) {
    let bestTopic = -1;
    let bestScore = -1;
    for (let ti = 0; ti < topics.length; ti += 1) {
      const score = matrix[ti]?.[oi] ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestTopic = ti;
      }
    }
    if (bestTopic < 0) continue;
    if (!ASSIGNABLE_STATES.has(relevanceState(bestScore, origin))) continue;
    assigned[bestTopic]!.push(opportunities[oi]!);
    bestByTopic[bestTopic] = Math.max(bestByTopic[bestTopic]!, bestScore);
  }

  interface Candidate {
    topic: CoreTopicDto;
    relevanceScore: number;
    opportunities: KeywordOpportunityDto[];
    totalVolume: number;
    bestOpportunityScore: number;
    competitorEvidence: OpportunityCompetitorDto[];
    facts: TopicCandidateFacts;
  }

  const candidates: Candidate[] = [];
  for (let ti = 0; ti < topics.length; ti += 1) {
    const rows = assigned[ti]!;
    if (rows.length === 0) continue;

    const relevanceScore = bestByTopic[ti]!;
    const totalVolume = rows.reduce((sum, row) => sum + (row.searchVolume ?? 0), 0);
    const bestOpportunityScore = rows.reduce((max, row) => Math.max(max, row.score), 0);
    const competitorEvidence = aggregateCompetitorEvidence(rows);
    const facts: TopicCandidateFacts = {
      relevanceScore,
      bestOpportunityScore,
      totalVolume,
      competitorCount: competitorEvidence.length,
    };
    candidates.push({
      topic: topics[ti]!,
      relevanceScore,
      opportunities: rows,
      totalVolume,
      bestOpportunityScore,
      competitorEvidence,
      facts,
    });
  }

  // Reduce to the strongest few candidates BEFORE any knowledge search, so a
  // 200-keyword snapshot never becomes 200 Qdrant queries.
  const orderedCandidates = [...candidates].sort(
    (a, b) => candidateRank(b.facts) - candidateRank(a.facts) || (a.topic.name < b.topic.name ? -1 : 1),
  );
  const topCandidates = orderedCandidates.slice(0, TOPIC_CANDIDATE_LIMIT);

  const recommendations: TopicRecommendationDto[] = [];
  for (const candidate of topCandidates) {
    const sortedKeywords = [...candidate.opportunities].sort(
      (a, b) => b.score - a.score || (a.keyword < b.keyword ? -1 : 1),
    );
    const relevance = relevanceState(candidate.relevanceScore, origin);

    let readiness: { state: KnowledgeReadinessState; sources: number; topScore?: number; note?: string };
    if (!knowledgeConfigured) {
      readiness = { state: 'none', sources: 0, note: 'Knowledge is not configured on this server.' };
    } else {
      const query = buildKnowledgeQuery(
        candidate.topic.name,
        candidate.topic.description,
        sortedKeywords.map((row) => row.keyword),
      );
      try {
        const response = await searchFn(projectId, { query, limit: KNOWLEDGE_READINESS_SEARCH_LIMIT });
        const hits = response.results.filter(
          (hit): hit is { source_id: string; score: number } =>
            typeof hit.source_id === 'string' && Number.isFinite(hit.score),
        );
        const state = knowledgeReadinessState(hits);
        const topScore = hits.length > 0 ? Math.max(...hits.map((hit) => hit.score)) : undefined;
        readiness = { state, sources: new Set(hits.map((hit) => hit.source_id)).size, topScore };
      } catch {
        readiness = { state: 'none', sources: 0, note: 'Knowledge search failed for this topic.' };
      }
    }

    const recommendation = decideRecommendation({
      relevance,
      readiness: readiness.state,
      bestOpportunityScore: candidate.bestOpportunityScore,
      totalVolume: candidate.totalVolume,
    });
    if (!recommendation) continue;

    const keywords: TopicOpportunityKeywordDto[] = sortedKeywords
      .slice(0, RECOMMENDATION_KEYWORDS_MAX)
      .map((row) => ({
        keyword: row.keyword,
        volume: row.searchVolume,
        opportunityScore: row.score,
        competitors: row.competitors,
      }));

    recommendations.push({
      topic: { name: candidate.topic.name, description: candidate.topic.description },
      relevance: { state: relevance, score: Number(candidate.relevanceScore.toFixed(4)) },
      knowledge: readiness,
      keywords,
      candidateCount: candidate.opportunities.length,
      totalVolume: candidate.totalVolume,
      bestOpportunityScore: candidate.bestOpportunityScore,
      competitorEvidence: candidate.competitorEvidence,
      recommendation,
      actionAvailable: recommendation === 'create_article',
      why: buildWhy({
        keywordCount: candidate.opportunities.length,
        totalVolume: candidate.totalVolume,
        competitorCount: candidate.competitorEvidence.length,
        relevance,
        readiness: readiness.state,
        recommendation,
      }),
    });
  }

  recommendations.sort(
    (a, b) => recommendationRank(candidateFacts(b), b.knowledge.state) - recommendationRank(candidateFacts(a), a.knowledge.state)
      || (a.topic.name < b.topic.name ? -1 : 1),
  );

  return {
    snapshot: opportunitiesDto.snapshot,
    recommendations: recommendations.slice(0, TOPIC_MAX_RECOMMENDATIONS),
    consideredCount: opportunities.length,
    candidateCount: candidates.length,
    knowledgeConfigured,
    topicsConfigured: true,
  };
}

/** Rebuild the ranking facts from a finished recommendation. */
function candidateFacts(recommendation: TopicRecommendationDto): TopicCandidateFacts {
  return {
    relevanceScore: recommendation.relevance.score ?? 0,
    bestOpportunityScore: recommendation.bestOpportunityScore,
    totalVolume: recommendation.totalVolume,
    competitorCount: recommendation.competitorEvidence.length,
  };
}

/** Build a bounded, structured opportunity context for the content agent. */
export function buildOpportunityContext(request: TopicArticleRequest): string {
  const lines: string[] = [`Topic: ${request.topic_name}`];
  if (request.topic_description) lines.push(`Topic description: ${request.topic_description}`);
  if (request.primary_keyword) lines.push(`Primary keyword: ${request.primary_keyword}`);
  const keywords = (request.keywords ?? [])
    .slice(0, 20)
    .map((row) => `${row.keyword}${row.volume != null ? ` (${row.volume}/mo)` : ''}`);
  if (keywords.length > 0) lines.push(`Matching keywords: ${keywords.join(', ')}`);
  const competitors = (request.competitors ?? [])
    .slice(0, 3)
    .map((row) => `${row.domain}${row.rank != null ? ` #${row.rank}` : ''}`);
  if (competitors.length > 0) lines.push(`Competitor evidence: ${competitors.join(', ')}`);
  if (request.opportunity_score != null) lines.push(`Opportunity score: ${request.opportunity_score}/100`);
  if (request.difficulty != null) lines.push(`Keyword difficulty: ${request.difficulty}/100`);
  if (request.intent) lines.push(`Search intent: ${request.intent}`);
  const reasons = (request.reasons ?? []).map((reason) => reason.replace(/_/g, ' '));
  if (reasons.length > 0) lines.push(`Why this opportunity: ${reasons.join(', ')}`);
  return lines.join('\n').slice(0, 4000);
}
