/**
 * Central retrieval budgets (KB10).
 *
 * Every candidate window is defined here, once. The pipeline never fetches an
 * unbounded list and never fetches a large list only to discard most of it in
 * JavaScript: each origin is asked for at most its own cap and the fused list
 * is capped before it leaves the boundary. These are internal values; the
 * public request/response limits stay in `@seo/contracts`.
 */

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
