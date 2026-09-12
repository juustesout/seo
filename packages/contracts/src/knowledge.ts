/**
 * Knowledge ingestion error taxonomy (KB3), shared by the API server and the
 * web app.
 *
 * A source row stores a stable machine code on failure - never a provider body
 * or a credential. Both sides render that code through the same sentence map so
 * the UI can never surface a raw upstream response, and the API can attach
 * status/retryability without duplicating the human text.
 */

export type KnowledgeIngestErrorCode =
  | 'knowledge_jina_not_configured'
  | 'knowledge_invalid_url'
  | 'knowledge_fetch_timeout'
  | 'knowledge_fetch_rate_limited'
  | 'knowledge_fetch_4xx'
  | 'knowledge_fetch_5xx'
  | 'knowledge_fetch_provider_error'
  | 'knowledge_empty_content'
  | 'knowledge_source_too_large'
  | 'knowledge_index_failed';

export const KNOWLEDGE_ERROR_MESSAGES: Record<KnowledgeIngestErrorCode, string> = {
  knowledge_jina_not_configured: 'URL fetching is not configured on this server. Set JINA_API_KEY on the API server.',
  knowledge_invalid_url: 'This URL is not allowed. Use a public http(s) address.',
  knowledge_fetch_timeout: 'Fetching the page timed out. Try again later.',
  knowledge_fetch_rate_limited: 'The fetch provider is rate limiting requests. Try again later.',
  knowledge_fetch_4xx: 'The page could not be fetched (the site refused the request).',
  knowledge_fetch_5xx: 'The fetch provider had a temporary error. Try again later.',
  knowledge_fetch_provider_error: 'The page could not be fetched right now. Try again later.',
  knowledge_empty_content: 'No readable content was found at this URL.',
  knowledge_source_too_large: 'This page is too large to index.',
  knowledge_index_failed: 'The content was fetched but could not be indexed. Try again later.',
};

/**
 * Render a stored source error as a safe human sentence. Known codes map to
 * their message; any other (legacy/free-form) value is returned unchanged.
 */
export function knowledgeErrorMessage(value: string | null | undefined): string {
  if (!value) return '';
  return KNOWLEDGE_ERROR_MESSAGES[value as KnowledgeIngestErrorCode] ?? value;
}
