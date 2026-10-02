/**
 * Per-provider circuit breaker.
 *
 * A provider that is failing hard (vendor outage, expired account, upstream
 * connection refused) should stop being called for a bounded cooldown instead
 * of having every queued job pile onto it. The breaker is the shared mechanism
 * for that: `withRetry` in `retry.ts` consults it before each attempt and
 * reports success/failure so state transitions are driven centrally rather
 * than by each provider.
 *
 * States: CLOSED (normal) -> OPEN (cooldown) -> HALF_OPEN (bounded probes) ->
 * CLOSED on a successful probe, OPEN again on a failed probe. Permanent and
 * validation failures must not trip the breaker, so `withRetry` only reports
 * retryable failures; see `retry.ts`.
 *
 * Like the in-memory rate limiter, breakers are per process. With the current
 * single-API/single-worker systemd topology that is the real protection; a
 * horizontally scaled API fleet would need a shared store behind the same
 * interface.
 */
import { logger } from '../logger.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive retryable failures in CLOSED state before opening. */
  failureThreshold: number;
  /** How long OPEN lasts before a HALF_OPEN probe is allowed. */
  cooldownMs: number;
  /** Probes allowed while HALF_OPEN before giving up and reopening. */
  halfOpenMaxProbes: number;
  /** Injectable clock so cooldown behavior is unit-testable. */
  now?: () => number;
}

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenMaxProbes: 2,
};

/**
 * Thrown when a call is refused because the breaker is OPEN. It is explicitly
 * retryable so a queued job backs off (via the job retry policy) instead of
 * being failed permanently, and no outbound request is made while refusing.
 */
export class CircuitOpenError extends Error {
  readonly retryable = true;
  readonly status = 503;
  constructor(public readonly provider: string) {
    super(`Circuit breaker is open for ${provider}`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probes = 0;
  private readonly now: () => number;

  constructor(
    public readonly provider: string,
    private readonly options: CircuitBreakerOptions = DEFAULT_CIRCUIT_BREAKER_OPTIONS,
  ) {
    this.now = options.now ?? Date.now;
  }

  get currentState(): CircuitState {
    return this.state;
  }

  /**
   * Whether a request may proceed. While OPEN and still inside the cooldown
   * this returns false and the caller must not make an outbound request. Once
   * the cooldown elapses it moves to HALF_OPEN and admits up to
   * `halfOpenMaxProbes` probes; further calls are refused until a probe
   * resolves the state.
   */
  canRequest(): boolean {
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.options.cooldownMs) return false;
      this.transition('half_open');
      this.probes = 0;
    }
    if (this.state === 'half_open') {
      if (this.probes >= this.options.halfOpenMaxProbes) return false;
      this.probes += 1;
      return true;
    }
    return true;
  }

  /** A successful call closes the breaker and clears the failure count. */
  onSuccess(): void {
    if (this.state !== 'closed') this.transition('closed');
    this.failures = 0;
    this.probes = 0;
  }

  /** A retryable failure counts toward opening the breaker. */
  onFailure(): void {
    if (this.state === 'half_open') {
      this.open();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) this.open();
  }

  private open(): void {
    this.openedAt = this.now();
    this.transition('open');
  }

  private transition(next: CircuitState): void {
    if (this.state === next) return;
    logger.warn({ provider: this.provider, from: this.state, to: next }, 'circuit breaker state change');
    this.state = next;
  }
}

const registry = new Map<string, CircuitBreaker>();

/**
 * Get (or lazily create) the shared breaker for a provider. A provider name
 * maps to exactly one breaker process-wide so every call path contributes to
 * and benefits from the same protection.
 */
export function getCircuitBreaker(provider: string): CircuitBreaker {
  let breaker = registry.get(provider);
  if (!breaker) {
    breaker = new CircuitBreaker(provider);
    registry.set(provider, breaker);
  }
  return breaker;
}

/** Test helper: drop all registered breakers so each test starts CLOSED. */
export function resetCircuitBreakers(): void {
  registry.clear();
}
