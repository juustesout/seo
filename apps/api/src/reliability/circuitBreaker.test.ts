import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  getCircuitBreaker,
  resetCircuitBreakers,
  type CircuitBreakerOptions,
} from './circuitBreaker.js';

function breaker(overrides: Partial<CircuitBreakerOptions> = {}) {
  return new CircuitBreaker('test-provider', {
    failureThreshold: 3,
    cooldownMs: 1_000,
    halfOpenMaxProbes: 1,
    now: () => 0,
    ...overrides,
  });
}

describe('CircuitBreaker', () => {
  it('starts closed and admits requests', () => {
    const b = breaker();
    expect(b.currentState).toBe('closed');
    expect(b.canRequest()).toBe(true);
  });

  it('opens after the failure threshold and blocks during cooldown', () => {
    let clock = 0;
    const b = breaker({ failureThreshold: 2, cooldownMs: 1_000, now: () => clock });
    b.onFailure();
    expect(b.currentState).toBe('closed');
    b.onFailure();
    expect(b.currentState).toBe('open');
    expect(b.canRequest()).toBe(false);
    clock = 999;
    expect(b.canRequest()).toBe(false);
  });

  it('moves to half-open after cooldown and closes on a successful probe', () => {
    let clock = 0;
    const b = breaker({ failureThreshold: 1, cooldownMs: 1_000, now: () => clock });
    b.onFailure();
    expect(b.currentState).toBe('open');
    clock = 1_000;
    expect(b.canRequest()).toBe(true);
    expect(b.currentState).toBe('half_open');
    b.onSuccess();
    expect(b.currentState).toBe('closed');
  });

  it('reopens when a half-open probe fails', () => {
    let clock = 0;
    const b = breaker({ failureThreshold: 1, cooldownMs: 1_000, now: () => clock });
    b.onFailure();
    clock = 1_000;
    expect(b.canRequest()).toBe(true);
    b.onFailure();
    expect(b.currentState).toBe('open');
  });

  it('caps half-open probes', () => {
    let clock = 0;
    const b = breaker({ failureThreshold: 1, cooldownMs: 1_000, halfOpenMaxProbes: 2, now: () => clock });
    b.onFailure();
    clock = 1_000;
    expect(b.canRequest()).toBe(true);
    expect(b.canRequest()).toBe(true);
    expect(b.canRequest()).toBe(false);
  });

  it('resets the failure count on success', () => {
    const b = breaker({ failureThreshold: 2 });
    b.onFailure();
    b.onSuccess();
    b.onFailure();
    expect(b.currentState).toBe('closed');
  });
});

describe('getCircuitBreaker', () => {
  it('returns one shared instance per provider', () => {
    resetCircuitBreakers();
    expect(getCircuitBreaker('acme')).toBe(getCircuitBreaker('acme'));
    expect(getCircuitBreaker('acme')).not.toBe(getCircuitBreaker('other'));
    resetCircuitBreakers();
  });
});

describe('CircuitOpenError', () => {
  it('is retryable and carries the provider', () => {
    const err = new CircuitOpenError('acme');
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(503);
    expect(err.provider).toBe('acme');
  });
});
