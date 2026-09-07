/**
 * Normalized, safe errors for publisher adapters (Content Studio Phase H5).
 *
 * Adapters throw PublisherError instead of leaking raw provider responses.
 * The worker's jobErrorPayload reads `status`/`code`/`retryable` so these map
 * straight onto seo_sync_jobs.error and the publication history without ever
 * exposing tokens, authorization headers or provider internals.
 *
 * Error vocabulary (code) - one of five normalized causes:
 *   publisher_not_available   adapter/env not ready (e.g. channel disabled,
 *                             credentials deleted) - always terminal.
 *   publisher_auth_failed     remote rejected our identity (401/403) - prompts
 *                             the user to reconnect the channel.
 *   publisher_rate_limited    remote rate limit (429) - retryable.
 *   publisher_rejected_content remote or local validation refused the payload
 *                             (other 4xx, or publisherRejected() before any
 *                             call) - terminal, retrying cannot help.
 *   publisher_media_invalid   referenced media could not be resolved/uploaded.
 *   publisher_remote_error    remote fault (5xx / network) - retryable.
 *
 * `retryable` semantics (honesty rule): a retryable error means the *same*
 * payload could succeed later (throttle, transient remote fault). A terminal
 * error means retrying the identical request is pointless and would only
 * produce duplicate side effects or guaranteed failure - so the worker marks
 * the job failed instead of looping. When an adapter does not set retryable,
 * it is derived from the HTTP status: 429/5xx => retryable, everything else
 * terminal. There is intentionally no status that is silently swallowed: a
 * publication is only ever "successful" when the adapter returned a confirmed
 * remote id, so no error path can turn into a fake success.
 */

export type PublisherErrorCode =
  | 'publisher_not_available'
  | 'publisher_auth_failed'
  | 'publisher_rate_limited'
  | 'publisher_rejected_content'
  | 'publisher_media_invalid'
  | 'publisher_remote_error';

/**
 * The exhaustive set of normalized publisher error codes, kept as a const
 * array so code can be validated/iterated (e.g. tests asserting no adapter
 * throws an out-of-vocabulary code).
 */
export const PUBLISHER_ERROR_CODES: readonly PublisherErrorCode[] = [
  'publisher_not_available',
  'publisher_auth_failed',
  'publisher_rate_limited',
  'publisher_rejected_content',
  'publisher_media_invalid',
  'publisher_remote_error',
];

/**
 * Normalized publisher failure. Adapters throw this - never a raw vendor
 * error - so the worker and the API can persist a safe, structured `error`
 * payload and decide retry behavior consistently for every publisher.
 * `message` must be user-safe (no tokens, no internal URLs/headers).
 */
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

/**
 * Map a remote HTTP status to its canonical error code. 429 -> rate limited,
 * 401/403 -> auth failed, other 4xx -> content rejected (the remote refused
 * this specific request), everything else -> remote error.
 */
function statusCode(status: number): PublisherErrorCode {
  if (status === 429) return 'publisher_rate_limited';
  if (status === 401 || status === 403) return 'publisher_auth_failed';
  if (status >= 400 && status < 500) return 'publisher_rejected_content';
  return 'publisher_remote_error';
}

/**
 * Build a normalized error from a remote HTTP status + safe message. The
 * retryable hint is derived from the status (429 or 5xx => retryable); an
 * adapter that knows better can still throw PublisherError directly with an
 * explicit override.
 */
export function publisherErrorFromStatus(status: number, message?: string): PublisherError {
  const code = statusCode(status);
  const retryable = status >= 500 || status === 429;
  return new PublisherError(code, message ?? `Remote platform returned HTTP ${status}`, { status, retryable });
}

/**
 * Adapter-side guard for content refused *before* any remote call (e.g. the
 * payload violates the platform's own rules: too long, empty, invalid media).
 * Always terminal - the remote never saw the request, so retrying the same
 * payload cannot succeed - and distinct from a remote rejection so the error
 * path recorded for the user says "content rejected" regardless of whether the
 * vendor or our local validation refused it.
 */
export function publisherRejected(message: string): PublisherError {
  return new PublisherError('publisher_rejected_content', message, { retryable: false });
}
