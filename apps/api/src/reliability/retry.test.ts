import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  RetryBudget,
  classifyRetry,
  currentRetryBudget,
  isRetryableError,
  retryDelayForAttempt,
  runWithRetryBudget,
  withRetry,
} from './retry.js';
import { CircuitBreaker, CircuitOpenError } from './circuitBreaker.js';

const noSleep = async () => {};
const noJitter = () => 0;
const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 };

function statusError(status: number, code?: string, retryable?: boolean) {
  return Object.assign(new Error(`http ${status}`), { status, code, retryable });
}

describe('classifyRetry', () => {
  it('classifies timeouts', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyRetry(err)).toBe('timeout');
  });

  it('classifies by HTTP status', () => {
    expect(classifyRetry(statusError(429))).toBe('rate_limited');
    expect(classifyRetry(statusError(500))).toBe('transient');
    expect(classifyRetry(statusError(503))).toBe('transient');
    expect(classifyRetry(statusError(401))).toBe('auth');
    expect(classifyRetry(statusError(403))).toBe('auth');
    expect(classifyRetry(statusError(400))).toBe('validation');
    expect(classifyRetry(statusError(404))).toBe('validation');
  });

  it('classifies permanent application codes', () => {
    expect(classifyRetry({ code: 'not_configured' })).toBe('validation');
    expect(classifyRetry({ code: 'unauthorized' })).toBe('auth');
    expect(classifyRetry({ code: 'conflict' })).toBe('validation');
  });

  it('treats an unknown error as a transient transport failure', () => {
    expect(classifyRetry(new Error('socket hang up'))).toBe('transient');
    expect(classifyRetry('nope')).toBe('transient');
  });

  it('honours an explicit retryable flag over the status', () => {
    expect(classifyRetry(statusError(500, undefined, false))).toBe('permanent');
    expect(classifyRetry(statusError(400, undefined, true))).toBe('transient');
    expect(classifyRetry(statusError(429, undefined, false))).toBe('permanent');
  });

  it('maps errors to job retryability', () => {
    expect(isRetryableError(statusError(429))).toBe(true);
    expect(isRetryableError(statusError(500))).toBe(true);
    expect(isRetryableError(new Error('network'))).toBe(true);
    expect(isRetryableError(statusError(401))).toBe(false);
    expect(isRetryableError(statusError(400))).toBe(false);
    expect(isRetryableError({ code: 'not_configured' })).toBe(false);
  });
});

describe('retryDelayForAttempt', () => {
  it('grows exponentially and caps at maxDelayMs', () => {
    expect(retryDelayForAttempt(1, policy, noJitter)).toBe(10);
    expect(retryDelayForAttempt(2, policy, noJitter)).toBe(20);
    expect(retryDelayForAttempt(3, policy, noJitter)).toBe(40);
    expect(retryDelayForAttempt(10, policy, noJitter)).toBe(100);
  });

  it('adds bounded jitter', () => {
    const withMaxJitter = retryDelayForAttempt(1, { ...policy, jitterRatio: 0.5 }, () => 1);
    expect(withMaxJitter).toBe(15);
  });

  it('defaults to four attempts', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(4);
  });
});

describe('withRetry', () => {
  it('returns the first successful result without retrying', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      return 'ok';
    }, { provider: 'p', operation: 'op', policy, sleep: noSleep, random: noJitter });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries transient failures then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw statusError(503);
      return 'recovered';
    }, { provider: 'p', operation: 'op', policy, sleep: noSleep, random: noJitter });
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('does not retry a non-retryable failure', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw statusError(400);
      }, { provider: 'p', operation: 'op', policy, sleep: noSleep, random: noJitter }),
    ).rejects.toThrow('http 400');
    expect(calls).toBe(1);
  });

  it('stops after maxAttempts', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw statusError(500);
      }, { provider: 'p', operation: 'op', policy, sleep: noSleep, random: noJitter }),
    ).rejects.toThrow('http 500');
    expect(calls).toBe(policy.maxAttempts);
  });

  it('uses the shared retry budget and stops when exhausted', async () => {
    const attempts: number[] = [];
    await runWithRetryBudget(new RetryBudget(1), async () => {
      await expect(
        withRetry(async (attempt) => {
          attempts.push(attempt);
          throw statusError(503);
        }, { provider: 'p', operation: 'op', policy: { ...policy, maxAttempts: 5 }, sleep: noSleep, random: noJitter }),
      ).rejects.toThrow();
    });
    // first attempt + exactly one budgeted retry, even though maxAttempts is 5.
    expect(attempts).toEqual([1, 2]);
  });

  it('shares one budget across nested calls', async () => {
    const attempts: number[] = [];
    const call = () =>
      withRetry(async (attempt) => {
        attempts.push(attempt);
        throw statusError(503);
      }, { provider: 'p', operation: 'op', policy: { ...policy, maxAttempts: 5 }, sleep: noSleep, random: noJitter });
    await runWithRetryBudget(new RetryBudget(1), async () => {
      await expect(call()).rejects.toThrow();
      await expect(call()).rejects.toThrow();
    });
    // first call consumes the one retry; the second gets a single attempt.
    expect(attempts).toEqual([1, 2, 1]);
  });

  it('exposes the active budget only inside the scope', async () => {
    expect(currentRetryBudget()).toBeUndefined();
    await runWithRetryBudget(new RetryBudget(2), async () => {
      expect(currentRetryBudget()?.left).toBe(2);
    });
    expect(currentRetryBudget()).toBeUndefined();
  });

  it('refuses to call an open breaker and reports outcomes', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker('p', {
      failureThreshold: 1,
      cooldownMs: 1_000,
      halfOpenMaxProbes: 1,
      now: () => clock,
    });
    let calls = 0;
    const failing = () =>
      withRetry(async () => {
        calls += 1;
        throw statusError(503);
      }, { provider: 'p', operation: 'op', policy: { ...policy, maxAttempts: 1 }, sleep: noSleep, breaker, random: noJitter });

    await expect(failing()).rejects.toThrow('http 503');
    expect(breaker.currentState).toBe('open');
    await expect(failing()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(1);

    // After cooldown a successful probe closes the breaker.
    clock = 1_000;
    const result = await withRetry(async () => 'ok', { provider: 'p', operation: 'op', policy, sleep: noSleep, breaker });
    expect(result).toBe('ok');
    expect(breaker.currentState).toBe('closed');
  });
});
