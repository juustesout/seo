/**
 * Optional reranking layer (KB10.3).
 *
 * Reranking is a quality layer, never required infrastructure: it runs AFTER
 * reconcile and fusion, sees only the bounded head of the already-scoped,
 * already-attributed candidate set, and on any failure the pipeline keeps the
 * deterministic RRF order. A reranker can therefore only improve ordering - it
 * can never make search fail, widen the scope, or introduce a candidate.
 *
 * The provider boundary is deliberately narrow: a reranker receives the query
 * and a list of `{ id, content }` pairs, where `id` is the canonical candidate
 * identity from KB10.1 and `content` is untrusted plain text. There are no
 * credentials, payloads, source records or storage paths in the request, and
 * candidate content lives in its own field so it can never become workflow
 * control for the provider. The result is validated against the exact input id
 * set: an unknown, duplicate or malformed entry invalidates the whole response
 * and the RRF order is kept.
 */

import type { KnowledgeQueryPlan } from './plan.js';
import {
  KNOWLEDGE_RERANK_MAX_CANDIDATES,
  KNOWLEDGE_RERANK_MAX_CONTENT_CHARS,
  KNOWLEDGE_RERANK_MAX_QUERY_CHARS,
  KNOWLEDGE_RERANK_MAX_TOTAL_CHARS,
} from './limits.js';
import type { KnowledgeCandidate } from './types.js';
import { logger } from '../../logger.js';

/** One candidate offered to a reranker: opaque id + bounded untrusted content. */
export interface KnowledgeRerankCandidate {
  /** Canonical candidate identity (`sourceId::chunkId`). Never used for ranking. */
  id: string;
  /** Untrusted, bounded plain text of the candidate. */
  content: string;
}

/** Rerank request: the normalized query plus the bounded candidate set. */
export interface KnowledgeRerankRequest {
  query: string;
  candidates: KnowledgeRerankCandidate[];
}

/** One provider ranking: a known candidate id and a finite relevance score. */
export interface KnowledgeRerankRanking {
  id: string;
  score: number;
}

/** Rerank result. May rank a subset of the request; never introduces an id. */
export interface KnowledgeRerankResult {
  rankings: KnowledgeRerankRanking[];
}

/**
 * Provider-agnostic reranking seam. Implementations own their own transport,
 * credentials, timeout and response parsing; the pipeline only ever sees this
 * interface and the normalized request/result types above.
 */
export interface KnowledgeReranker {
  readonly id: string;
  readonly name: string;
  /** False when the server lacks the credentials this reranker needs. */
  isConfigured(): boolean;
  /** Rerank a bounded candidate set. Throws on any provider/transport failure. */
  rerank(request: KnowledgeRerankRequest): Promise<KnowledgeRerankResult>;
}

/** Safe, classified rerank failures; never carries a provider body or credential. */
export type KnowledgeRerankErrorCode = 'not_configured' | 'timeout' | 'provider_error' | 'invalid_response';

const RERANK_ERROR_MESSAGES: Record<KnowledgeRerankErrorCode, string> = {
  not_configured: 'The knowledge reranker is not configured.',
  timeout: 'The knowledge reranker timed out.',
  provider_error: 'The knowledge reranker provider failed.',
  invalid_response: 'The knowledge reranker returned an invalid response.',
};

export class KnowledgeRerankError extends Error {
  constructor(readonly code: KnowledgeRerankErrorCode) {
    super(RERANK_ERROR_MESSAGES[code]);
    this.name = 'KnowledgeRerankError';
  }
}

/**
 * Explicit "no reranker" implementation. It is honest by construction: it
 * reports itself unconfigured, produces no scores and is never called by the
 * pipeline. The pipeline keeps the RRF order, so there is no hidden AI call and
 * no fake ranking.
 */
export class NoopKnowledgeReranker implements KnowledgeReranker {
  readonly id = 'none';
  readonly name = 'No reranker';

  isConfigured(): boolean {
    return false;
  }

  async rerank(): Promise<KnowledgeRerankResult> {
    return { rankings: [] };
  }
}

export const NO_KNOWLEDGE_RERANKER: KnowledgeReranker = new NoopKnowledgeReranker();

/**
 * Build the bounded rerank request from the fusion head. Content is truncated
 * per candidate and capped in total, so payload size is bounded independently
 * of the candidate count. Query and content are separate fields; the query is
 * never concatenated with candidate text.
 */
export function buildKnowledgeRerankRequest(
  query: string,
  candidates: readonly KnowledgeCandidate[],
): KnowledgeRerankRequest {
  const bounded: KnowledgeRerankCandidate[] = [];
  let total = 0;
  for (const candidate of candidates) {
    const content = candidate.content.slice(0, KNOWLEDGE_RERANK_MAX_CONTENT_CHARS).trim();
    if (!content) continue;
    if (total + content.length > KNOWLEDGE_RERANK_MAX_TOTAL_CHARS) break;
    total += content.length;
    bounded.push({ id: candidate.key, content });
  }
  return { query: query.slice(0, KNOWLEDGE_RERANK_MAX_QUERY_CHARS), candidates: bounded };
}

/**
 * Validate a provider result against the exact candidate set that was sent and
 * return the deterministic new order of those candidates (ranked ids first,
 * then every unranked id in its original fusion order). Returns null when the
 * response is unusable, in which case the caller keeps the RRF order.
 *
 * Rejected as unusable: a non-array payload, an unknown/foreign id, a duplicate
 * id, a non-finite or non-numeric score, or an empty ranking. A partial ranking
 * is valid and deterministic: unranked candidates are preserved in order, so no
 * candidate can disappear through an incomplete provider response.
 */
export function applyRerankRankings(
  sent: readonly KnowledgeCandidate[],
  result: KnowledgeRerankResult,
): string[] | null {
  if (!result || !Array.isArray(result.rankings)) return null;
  const allowed = new Set(sent.map((candidate) => candidate.key));
  const seen = new Set<string>();
  const ranked: Array<{ id: string; score: number; index: number }> = [];

  for (const [index, entry] of result.rankings.entries()) {
    if (!entry || typeof entry !== 'object') return null;
    const id = (entry as { id?: unknown }).id;
    const score = (entry as { score?: unknown }).score;
    if (typeof id !== 'string' || !allowed.has(id)) return null;
    if (seen.has(id)) return null;
    if (typeof score !== 'number' || !Number.isFinite(score)) return null;
    seen.add(id);
    ranked.push({ id, score, index });
  }
  if (ranked.length === 0) return null;

  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  const orderedRanked = ranked.map((entry) => entry.id);
  const remaining = sent.map((candidate) => candidate.key).filter((key) => !seen.has(key));
  return [...orderedRanked, ...remaining];
}

export interface RerankOutcome {
  candidates: KnowledgeCandidate[];
  /** True only when a configured reranker returned a usable ranking. */
  applied: boolean;
  /** True when a configured reranker was tried and failed (fallback used). */
  failed: boolean;
}

/**
 * Run the optional rerank step over the fusion output. Always resolves: a
 * missing/unconfigured reranker, an empty candidate set, a timeout, a provider
 * error or an invalid response all leave the RRF order untouched. Only a valid
 * ranking reorders candidates, and it can never add, drop or duplicate one.
 */
export async function rerankCandidates(
  reranker: KnowledgeReranker,
  plan: KnowledgeQueryPlan,
  candidates: readonly KnowledgeCandidate[],
): Promise<RerankOutcome> {
  if (!reranker.isConfigured() || candidates.length === 0) {
    return { candidates: [...candidates], applied: false, failed: false };
  }

  const head = candidates.slice(0, KNOWLEDGE_RERANK_MAX_CANDIDATES);
  const request = buildKnowledgeRerankRequest(plan.query, head);
  const sentKeys = new Set(request.candidates.map((candidate) => candidate.id));
  const sent = head.filter((candidate) => sentKeys.has(candidate.key));
  if (sent.length === 0) {
    return { candidates: [...candidates], applied: false, failed: false };
  }

  let result: KnowledgeRerankResult;
  try {
    result = await reranker.rerank(request);
  } catch (err) {
    logger.warn({ err, reranker: reranker.id }, 'knowledge rerank failed; keeping fusion order');
    return { candidates: [...candidates], applied: false, failed: true };
  }

  const order = applyRerankRankings(sent, result);
  if (!order) {
    logger.warn({ reranker: reranker.id }, 'knowledge rerank returned unusable output; keeping fusion order');
    return { candidates: [...candidates], applied: false, failed: true };
  }

  const rankIndex = new Map(order.map((key, index) => [key, index]));
  const rerankedHead = [...sent].sort(
    (a, b) => rankIndex.get(a.key)! - rankIndex.get(b.key)!,
  );
  // Candidates in the head that were not sent (total-char cap) keep their
  // fusion order; anything past the head is untouched.
  const unsentHead = head.filter((candidate) => !sentKeys.has(candidate.key));
  const tail = candidates.slice(head.length);
  return { candidates: [...rerankedHead, ...unsentHead, ...tail], applied: true, failed: false };
}
