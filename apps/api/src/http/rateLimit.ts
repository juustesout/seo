/**
 * Fixed-window, in-memory rate limiter for the API perimeter.
 *
 * Why in-memory: the API runs as a small number of long-lived Node processes
 * behind one reverse proxy and the goal is to blunt abuse/cost explosions (a
 * runaway client, a leaked key, an OAuth-callback hammer), not to bill exact
 * per-tenant quotas. A per-process counter needs no new infrastructure and no
 * shared dependency; if the API is ever scaled horizontally a shared store
 * (Redis/table) can replace the Map behind the same middleware shape.
 *
 * The limiter is deliberately fail-open on storage (a Map cannot fail) and
 * returns the shared `{ error: { code: 'rate_limited' } }` envelope via the
 * terminal error handler, so clients see the same wire shape as every other
 * error. Windows are fixed (not sliding) - cheap and adequate at this scale.
 */
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../apiErrors.js';

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per key within one window. */
  max: number;
  /** Stable per-caller key; defaults to the authenticated user or the client IP. */
  keyGenerator?: (req: Request) => string;
  /** Injectable clock so the window/reset behavior is unit-testable. */
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Identity key: prefer the verified user, fall back to the proxy-resolved IP. */
function defaultKey(req: Request): string {
  return req.user?.sub ?? req.ip ?? 'unknown';
}

/**
 * Build an express middleware enforcing `max` requests per `windowMs` per key.
 * Expired buckets are swept opportunistically (at most once per sweep interval)
 * so the map stays bounded under normal churn without a background timer.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const { windowMs, max, keyGenerator = defaultKey, now = Date.now } = options;
  const buckets = new Map<string, Bucket>();
  const sweepIntervalMs = Math.max(1000, Math.min(windowMs, 60_000));
  let lastSweep = now();

  function sweep(at: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
    lastSweep = at;
  }

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const at = now();
    if (at - lastSweep >= sweepIntervalMs) sweep(at);

    const key = keyGenerator(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      bucket = { count: 0, resetAt: at + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const resetSeconds = Math.max(0, Math.ceil((bucket.resetAt - at) / 1000));
    res.setHeader('ratelimit-limit', String(max));
    res.setHeader('ratelimit-remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('ratelimit-reset', String(resetSeconds));

    if (bucket.count > max) {
      res.setHeader('retry-after', String(resetSeconds));
      next(ApiError.rateLimited('Too many requests', { retryAfterSeconds: resetSeconds }));
      return;
    }
    next();
  };
}
