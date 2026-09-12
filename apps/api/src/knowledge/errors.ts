/**
 * Normalized knowledge ingestion errors (KB3).
 *
 * The service persists a stable machine code (never a provider body or a
 * credential) on the source row for fetch/index failures, and the job layer
 * gets an explicit retryability flag so it can apply its own backoff policy.
 * The code -> human sentence map and the code union are shared via
 * `@seo/contracts` so the web UI renders the same safe text.
 *
 * Retryability classification:
 *   - permanent: bad config, bad URL, empty/oversized content, most 4xx
 *   - temporary: timeout, rate limit, 5xx, transport errors
 *   - local: index failures (temporary - the job layer may retry)
 */

import { KNOWLEDGE_ERROR_MESSAGES, type KnowledgeIngestErrorCode } from '@seo/contracts';

export type { KnowledgeIngestErrorCode } from '@seo/contracts';
export { knowledgeErrorMessage } from '@seo/contracts';

interface ErrorMeta {
  status: number;
  retryable: boolean;
  message: string;
}

const META: Record<KnowledgeIngestErrorCode, ErrorMeta> = {
  knowledge_jina_not_configured: {
    status: 503,
    retryable: false,
    message: KNOWLEDGE_ERROR_MESSAGES.knowledge_jina_not_configured,
  },
  knowledge_invalid_url: {
    status: 400,
    retryable: false,
    message: KNOWLEDGE_ERROR_MESSAGES.knowledge_invalid_url,
  },
  knowledge_fetch_timeout: {
    status: 504,
    retryable: true,
    message: KNOWLEDGE_ERROR_MESSAGES.knowledge_fetch_timeout,
  },
  knowledge_fetch_rate_limited: {
    status: 429,
    retryable: true,
    message: KNOWLEDGE_ERROR_MESSAGES.knowledge_fetch_rate_limited,
  },
  knowledge_fetch_4xx: {
    status: 502,
    retryable: false,
    message: KNOWLEDGE_ERROR_MESSAGES.knowledge_fetch_4xx,
  },
  knowledge_fetch_5xx: {
    status: 502,
    retryable: true,
    message: KNOWLEDGE_ERROR_MESSAGES.knowledge_fetch_5xx,
  },
  knowledge_fetch_provider_error: {
    status: 502,
    retryable: true,
    message: KNOWLEDGE_ERROR_MESSAGES.knowledge_fetch_provider_error,
  },
  knowledge_empty_content: {
    status: 422,
    retryable: false,
    message: KNOWLEDGE_ERROR_MESSAGES.knowledge_empty_content,
  },
  knowledge_source_too_large: {
    status: 413,
    retryable: false,
    message: KNOWLEDGE_ERROR_MESSAGES.knowledge_source_too_large,
  },
  knowledge_index_failed: {
    status: 502,
    retryable: true,
    message: KNOWLEDGE_ERROR_MESSAGES.knowledge_index_failed,
  },
};

/** Error carrying a stable code, a safe message and an explicit retryability. */
export class KnowledgeIngestError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(readonly code: KnowledgeIngestErrorCode) {
    super(META[code].message);
    this.name = 'KnowledgeIngestError';
    this.status = META[code].status;
    this.retryable = META[code].retryable;
  }
}

export function isKnowledgeIngestError(err: unknown): err is KnowledgeIngestError {
  return err instanceof KnowledgeIngestError;
}

