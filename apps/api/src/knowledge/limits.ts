/**
 * Central resource limits for knowledge ingestion (KB3).
 *
 * Kept in one place so fetching, normalization and indexing share the same
 * conservative, memory- and runtime-bounded defaults. Everything here is a
 * hard stop: exceeding a limit fails the source (never a partial 'ready').
 */

/** Longest URL accepted from a user or handed to a fetcher. */
export const MAX_URL_LENGTH = 2048;

/** Hard timeout for one external fetch (the job layer owns retry/backoff). */
export const FETCH_TIMEOUT_MS = 20_000;

/** Transport cap while reading a fetch response, to bound memory. */
export const MAX_FETCHED_BYTES = 4_000_000;

/** Largest extracted body accepted from a fetcher, before normalization. */
export const MAX_FETCHED_CHARS = 500_000;

/** Largest normalized body kept for indexing. */
export const MAX_NORMALIZED_CHARS = 200_000;

/** Hard cap on chunks per source; exceeding it fails rather than partially index. */
export const MAX_CHUNKS = 400;

/** Largest uploaded file accepted for a knowledge source (bytes), enforced at
 *  the HTTP boundary before storage and re-checked before extraction. */
export const KNOWLEDGE_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Largest extracted text kept from an uploaded file, before normalization. */
export const KNOWLEDGE_MAX_EXTRACTED_CHARS = 200_000;

/** Default page size for the knowledge source library list. */
export const KNOWLEDGE_LIST_DEFAULT_LIMIT = 50;

/** Hard maximum page size; a client can never pull an unbounded list. */
export const KNOWLEDGE_LIST_MAX_LIMIT = 100;

/** Longest metadata search term accepted (bound before it reaches the DB). */
export const KNOWLEDGE_SEARCH_MAX_CHARS = 200;

/** Hard cap on the plain-text content preview returned by the detail surface. */
export const KNOWLEDGE_PREVIEW_MAX_CHARS = 2000;
