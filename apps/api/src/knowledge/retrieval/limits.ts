/**
 * Central retrieval budgets (KB10/KB10.3).
 *
 * Every candidate window is defined here, once. The pipeline never fetches an
 * unbounded list and never fetches a large list only to discard most of it in
 * JavaScript: each origin is asked for at most its own cap and the fused list
 * is capped before it leaves the boundary. These are internal values; the
 * public request/response limits stay in `@seo/contracts`.
 */

import { KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS, KNOWLEDGE_SEARCH_QUERY_MAX_CHARS } from '@seo/contracts';

/** Hard cap on vector candidates requested from the provider. */
export const KNOWLEDGE_RETRIEVAL_VECTOR_CANDIDATES = 50;

/** Hard cap on lexical candidates requested from Postgres. */
export const KNOWLEDGE_RETRIEVAL_LEXICAL_CANDIDATES = 50;

/** Hard cap on the fused candidate list before attribution. */
export const KNOWLEDGE_RETRIEVAL_FUSED_CANDIDATES = 50;

/**
 * Reciprocal rank fusion constant: `score(d) = sum(1 / (k + rank))`. 60 is the
 * widely used default; keeping it here means the ranking policy has one owner.
 */
export const KNOWLEDGE_RETRIEVAL_RRF_K = 60;

/**
 * Hard cap on the derived source scope a metadata filter may resolve to. Some
 * filters (freshness) are derived in the app from stored facts rather than
 * stored in the vector index, so honouring them means materialising a bounded
 * set of managed source ids and restricting both origins to it. A project with
 * more matching ready sources than this cannot be scoped efficiently, so the
 * request fails closed instead of silently scanning or partially filtering.
 */
export const KNOWLEDGE_RETRIEVAL_MAX_SCOPE_SOURCES = 500;

/**
 * Reranking budgets (KB10.3).
 *
 * A reranker only ever sees the bounded head of the fused list - never the full
 * knowledge base, never an unbounded chunk. Query and per-candidate content are
 * capped with the shared public bounds, and a total content cap keeps one
 * request's payload small regardless of the candidate count. These are internal;
 * the reranker is optional and every cap is a hard stop, not a hint.
 */

/** Hard cap on candidates forwarded to the reranker (the fused head). */
export const KNOWLEDGE_RERANK_MAX_CANDIDATES = 20;

/** Query cap; identical to the public search query bound (already normalized). */
export const KNOWLEDGE_RERANK_MAX_QUERY_CHARS = KNOWLEDGE_SEARCH_QUERY_MAX_CHARS;

/** Per-candidate content cap; identical to the public content bound. */
export const KNOWLEDGE_RERANK_MAX_CONTENT_CHARS = KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS;

/** Total content cap across all forwarded candidates, independent of count. */
export const KNOWLEDGE_RERANK_MAX_TOTAL_CHARS = 16_000;

/** Hard timeout for one rerank call; on expiry the pipeline keeps the RRF order. */
export const KNOWLEDGE_RERANK_TIMEOUT_MS = 8_000;

/** Bound on a rerank HTTP response body, so a provider cannot stream unbounded data. */
export const KNOWLEDGE_RERANK_MAX_RESPONSE_BYTES = 256 * 1024;
