/**
 * Outbound HTTP timeout helper. Every provider call must be bounded so a hung
 * upstream connection cannot pin a worker job or an HTTP request forever. The
 * helper merges any caller-supplied abort signal with a timeout signal and
 * always cleans up the timer, and it works with the injected `fetchFn` used
 * throughout the provider layer (so tests can still substitute fetch).
 */

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;

export class OutboundTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Outbound request timed out after ${timeoutMs}ms`);
    this.name = 'OutboundTimeoutError';
  }
}

/**
 * fetch() with a hard timeout. `init.signal` (if any) is still honored: aborting
 * it aborts the request, and the timeout aborts it too - whichever fires first.
 * A non-positive timeout disables the bound (caller opted out).
 */
export async function fetchWithTimeout(
  fetchFn: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_OUTBOUND_TIMEOUT_MS,
): Promise<Response> {
  if (!(timeoutMs > 0)) return fetchFn(input, init);

  const controller = new AbortController();
  const upstream = init.signal;
  const onUpstreamAbort = () => controller.abort(upstream?.reason);
  if (upstream) {
    if (upstream.aborted) controller.abort(upstream.reason);
    else upstream.addEventListener('abort', onUpstreamAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new OutboundTimeoutError(timeoutMs));
  }, timeoutMs);

  try {
    return await fetchFn(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new OutboundTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener('abort', onUpstreamAbort);
  }
}

/** True when an error is our timeout (or a generic fetch abort). */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof OutboundTimeoutError || (err instanceof Error && err.name === 'AbortError');
}
