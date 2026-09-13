/**
 * Canonical retrieval query normalization (KB10.2).
 *
 * There is exactly one normalizer for the whole retrieval boundary. It trims,
 * collapses control characters and whitespace, and applies the shared length
 * bound - it never rewrites, expands, or invents query terms. The same string
 * is handed to the vector origin, the lexical origin and the public response
 * so no provider ever sees a private query variant.
 */

import { KNOWLEDGE_SEARCH_QUERY_MAX_CHARS } from '@seo/contracts';

/**
 * Normalize a retrieval query: control characters become spaces, runs of
 * whitespace collapse, and the result is hard-capped. Returns '' for a blank
 * query so the caller can reject it instead of searching for whitespace.
 */
export function normalizeKnowledgeQuery(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, KNOWLEDGE_SEARCH_QUERY_MAX_CHARS);
}
