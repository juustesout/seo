/**
 * Normalized, safe errors for publisher adapters (Content Studio Phase H5).
 *
 * Adapters throw PublisherError instead of leaking raw provider responses.
 * The worker's jobErrorPayload reads `status`/`code`/`retryable` so these map
 * straight onto seo_sync_jobs.error and the publication history without ever
 * exposing tokens, authorization headers or provider internals.
 */

export type PublisherErrorCode =
  | 'publisher_not_available'
  | 'publisher_auth_failed'
  | 'publisher_rate_limited'
  | 'publisher_rejected_content'
  | 'publisher_media_invalid'
  | 'publisher_remote_error';

export const PUBLISHER_ERROR_CODES: readonly PublisherErrorCode[] = [
  'publisher_not_available',
  'publisher_auth_failed',
  'publisher_rate_limited',
  'publisher_rejected_content',
  'publisher_media_invalid',
  'publisher_remote_error',
];

export class PublisherError extends Error {
  constructor(
    public readonly code: PublisherErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'PublisherError';
    this.status = options.status ?? null;
    this.retryable = options.retryable;
  }

  /** Remote HTTP status when the platform responded; null otherwise. */
  readonly status: number | null;
  /** Explicit retry hint; when undefined the worker derives it from status. */
  readonly retryable?: boolean;
}

function statusCode(status: number): PublisherErrorCode {
  if (status === 429) return 'publisher_rate_limited';
  if (status === 401 || status === 403) return 'publisher_auth_failed';
  if (status >= 400 && status < 500) return 'publisher_rejected_content';
  return 'publisher_remote_error';
}

/** Build a normalized error from a remote HTTP status + safe message. */
export function publisherErrorFromStatus(status: number, message?: string): PublisherError {
  const code = statusCode(status);
  const retryable = status >= 500 || status === 429;
  return new PublisherError(code, message ?? `Remote platform returned HTTP ${status}`, { status, retryable });
}

/** Adapter-side guard: content rejected before any remote call. */
export function publisherRejected(message: string): PublisherError {
  return new PublisherError('publisher_rejected_content', message, { retryable: false });
}
