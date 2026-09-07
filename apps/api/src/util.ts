/**
 * Small shared utilities (server-side): sleep/pacing primitives used by the
 * worker and long-running jobs, plus tiny list/coercion helpers used across
 * services. Nothing here touches Supabase or providers - it is pure code that
 * any package in the monorepo could reuse.
 */

/**
 * Resolve after `ms` milliseconds. The basic pacing/backoff primitive; callers
 * that must be interruptible (worker shutdown, cancellable waits) should use
 * sleepAbortable instead, which observes an AbortSignal.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Like delay, but rejects with an Error('aborted') when `signal` fires (or was
 * already aborted before the call). Used where a sleep must not outlive a
 * shutdown signal or a cancelled run - without the signal the process would
 * keep the event loop busy for the whole sleep even after work was cancelled.
 */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

/**
 * Lenient number coercion that never yields NaN or Infinity: accepts finite
 * numbers and trimmed numeric strings, returns null for everything else
 * (including '', whitespace and 'Infinity'). Used where a value may arrive
 * already-typed or as a query/param string and must be compared or stored as a
 * number; the null result lets callers fall back to a default instead of
 * propagating NaN through arithmetic.
 */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * First element of an array, or undefined - null/undefined-safe where callers
 * expect a single value but a query may have returned an array or nothing.
 */
export function firstOf<T>(arr: T[] | undefined | null): T | undefined {
  return arr?.[0];
}

/**
 * Deduplicate an array preserving first-occurrence order. Used before writes
 * that are keyed on a value with a unique constraint, where a duplicated entry
 * would otherwise abort the whole batch.
 */
export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
