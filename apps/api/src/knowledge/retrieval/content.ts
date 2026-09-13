/**
 * Bounded content extraction for retrieval hits (KB10).
 *
 * Retrieval content is untrusted data: it is never interpreted as markup and
 * always truncated server-side so the browser can never receive an unbounded
 * body through search. Kept dependency-free so both the vector adapter and the
 * service's attribution step apply the exact same bound.
 */

import { KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS } from '@seo/contracts';

/** Bounded plain-text content of one hit, or null when it carries no text. */
export function buildSearchContent(payload: Record<string, unknown>): string | null {
  const raw = typeof payload.text === 'string' ? payload.text : '';
  const text = raw.trim();
  if (!text) return null;
  return text.slice(0, KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS);
}
