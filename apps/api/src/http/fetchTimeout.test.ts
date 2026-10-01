import { describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout, isTimeoutError, OutboundTimeoutError } from './fetchTimeout.js';

/** A fetch stand-in that never resolves until its signal aborts. */
function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason ?? new Error('aborted'));
      else signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
    })) as unknown as typeof fetch;
}

describe('fetchWithTimeout', () => {
  it('passes through unchanged when the timeout is disabled', async () => {
    const fetchFn = vi.fn(async () => new Response('ok'));
    await fetchWithTimeout(fetchFn as unknown as typeof fetch, 'http://x', {}, 0);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('aborts a hung request and throws OutboundTimeoutError', async () => {
    await expect(fetchWithTimeout(hangingFetch(), 'http://x', {}, 10)).rejects.toBeInstanceOf(
      OutboundTimeoutError,
    );
  });

  it('honors an upstream abort signal', async () => {
    const controller = new AbortController();
    const promise = fetchWithTimeout(hangingFetch(), 'http://x', { signal: controller.signal }, 60_000);
    controller.abort();
    await expect(promise).rejects.toBeTruthy();
  });

  it('classifies timeout errors', () => {
    expect(isTimeoutError(new OutboundTimeoutError(5))).toBe(true);
    expect(isTimeoutError(new Error('nope'))).toBe(false);
  });
});
