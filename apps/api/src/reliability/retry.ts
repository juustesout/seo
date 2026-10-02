/**
 * Shared retry policy, failure classification and per-logical-operation retry
 * budget.
 *
 * Why one module: retry logic had drifted. DataForSEO retried internally up to
 * four attempts, every other provider relied on the job retry, and a job could
 * therefore issue `job_retries x provider_retries` outbound calls for one
 * operation (a keyword job makes many DataForSEO calls, each with its own
 * loop). Centralizing classification and the budget bounds that amplification
 * without changing what a successful call does.
 *
 * Two layers:
 *   - `withRetry(fn, { policy, provider, operation, breaker })` retries a single
 *     outbound operation with exponential backoff + jitter, but only for
 *     retryable classes (transient / rate_limited / timeout). Auth, validation
 *     and permanent failures throw immediately.
 *   - `runWithRetryBudget(new RetryBudget(n), fn)` caps the *total* number of
 *     retries across every nested provider call in one logical operation (a
 *     worker job execution). When the budget is exhausted, `withRetry` stops
 *     retrying and propagates the failure so the existing job retry policy
 *     decides the next move.
 *
 * Classification is also the single source of truth for job failure
 * retryability (`isRetryableError`), so the worker and the provider layer agree.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { delay } from '../util.js';
import { isTimeoutError } from '../http/fetchTimeout.js';
import { logger } from '../logger.js';
import { CircuitOpenError, type CircuitBreaker } from './circuitBreaker.js';

export type RetryClass = 'transient' | 'rate_limited' | 'timeout' | 'auth' | 'validation' | 'permanent';

/** Application error codes that can never succeed on retry. */
export const PERMANENT_CODES = new Set([
  'not_configured',
  'unsupported_job_type',
  'validation_error',
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'invalid_credentials',
]);

const AUTH_CODES = new Set(['unauthorized', 'forbidden', 'invalid_credentials']);

function classForCode(code: string): RetryClass {
  if (AUTH_CODES.has(code)) return 'auth';
  if (PERMANENT_CODES.has(code)) return 'validation';
  return 'permanent';
}

/** Only these classes are worth another attempt. */
export function isRetryableClass(cls: RetryClass): boolean {
  return cls === 'transient' || cls === 'rate_limited' || cls === 'timeout';
}

/**
 * Classify a thrown error. An explicit `retryable` flag (e.g. DataForSeoError)
 * wins over inference; otherwise a permanent application code is checked
 * *before* HTTP status, because codes like `not_configured` deliberately carry
 * a 503 yet must never be retried. Then timeout shape, HTTP status and the
 * permanent application-code set decide. Unknown failures (no status, no code)
 * are transport-level and treated as transient, matching the job store's
 * existing behavior.
 */
export function classifyRetry(err: unknown): RetryClass {
  const status = (err as { status?: number } | null)?.status;
  const code = (err as { code?: string } | null)?.code;
  const explicit = (err as { retryable?: boolean } | null)?.retryable;

  let derived: RetryClass;
  if (isTimeoutError(err)) {
    derived = 'timeout';
  } else if (typeof code === 'string' && PERMANENT_CODES.has(code)) {
    derived = classForCode(code);
  } else if (typeof status === 'number') {
    if (status === 429) derived = 'rate_limited';
    else if (status >= 500) derived = 'transient';
    else if (status === 401 || status === 403) derived = 'auth';
    else derived = 'validation';
  } else {
    derived = 'transient';
  }

  if (explicit === true) {
    // A provider that says "retryable" overrides a pessimistic status/code
    // derivation (e.g. a wrapped timeout), but keep the fine class when it is
    // already a retryable one.
    return isRetryableClass(derived) ? derived : 'transient';
  }
  if (explicit === false) {
    return isRetryableClass(derived) ? 'permanent' : derived;
  }
  return derived;
}

/** Convenience for the job store: is this error eligible for the job retry? */
export function isRetryableError(err: unknown): boolean {
  return isRetryableClass(classifyRetry(err));
}

export interface RetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number;
  /** Backoff base; attempt N waits base * 2^(N-1). */
  baseDelayMs: number;
  /** Upper bound on a single backoff before jitter. */
  maxDelayMs: number;
  /** Fraction of the delay added as random jitter, 0 disables jitter. */
  jitterRatio: number;
}

/** Default policy: 4 attempts, 1s exponential backoff capped at 30s. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.5,
};

/** Backoff after `attempt` (1-based), exponential capped plus jitter. */
export function retryDelayForAttempt(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const exp = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, policy.maxDelayMs);
  const jitter = capped * policy.jitterRatio * random();
  return Math.round(Math.min(capped + jitter, policy.maxDelayMs));
}

/**
 * A per-logical-operation allowance of retries. Every `withRetry` scheduled
 * inside `runWithRetryBudget` consumes one unit; the counter is shared across
 * concurrent nested calls because it is the same object in the async context.
 */
export class RetryBudget {
  private remaining: number;
  constructor(limit: number) {
    this.remaining = Math.max(0, Math.floor(limit));
  }
  /** Consume one retry if available; false when exhausted. */
  tryConsume(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    return true;
  }
  get left(): number {
    return this.remaining;
  }
}

const budgetStorage = new AsyncLocalStorage<RetryBudget>();

/** Run `fn` with a retry budget shared by every nested `withRetry` call. */
export function runWithRetryBudget<T>(budget: RetryBudget, fn: () => Promise<T>): Promise<T> {
  return budgetStorage.run(budget, fn);
}

/** The active budget for the current logical operation, if any. */
export function currentRetryBudget(): RetryBudget | undefined {
  return budgetStorage.getStore();
}

export interface WithRetryOptions {
  provider: string;
  operation: string;
  policy?: RetryPolicy;
  /** Optional breaker: refuses calls while OPEN and learns from outcomes. */
  breaker?: CircuitBreaker;
  /** Injectable RNG for deterministic tests. */
  random?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `fn` with bounded retries. `fn` receives the 1-based attempt number so a
 * caller can vary the request (rarely needed). Non-retryable failures and an
 * exhausted attempt count or budget propagate the original error unchanged.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: WithRetryOptions,
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleep ?? delay;
  const budget = currentRetryBudget();

  for (let attempt = 1; ; attempt += 1) {
    if (options.breaker && !options.breaker.canRequest()) {
      throw new CircuitOpenError(options.provider);
    }
    try {
      const result = await fn(attempt);
      options.breaker?.onSuccess();
      return result;
    } catch (err) {
      const cls = classifyRetry(err);
      const retryable = isRetryableClass(cls);
      // Only retryable failures count against the breaker; a validation error
      // must never trip it.
      if (retryable) options.breaker?.onFailure();

      if (!retryable || attempt >= policy.maxAttempts) throw err;

      if (budget && !budget.tryConsume()) {
        logger.warn(
          { provider: options.provider, operation: options.operation, attempt, retryClass: cls },
          'retry budget exhausted; propagating failure',
        );
        throw err;
      }

      const waitMs = retryDelayForAttempt(attempt, policy, options.random);
      logger.warn(
        { provider: options.provider, operation: options.operation, attempt, retryClass: cls, waitMs },
        'retrying after failure',
      );
      await sleep(waitMs);
    }
  }
}
