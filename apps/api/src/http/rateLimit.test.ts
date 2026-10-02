import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createRateLimiter } from './rateLimit.js';
import { ApiError, errorHandler } from '../apiErrors.js';

/** Invoke the limiter once and capture headers + whatever it passed to next(). */
function callLimiter(mw: ReturnType<typeof createRateLimiter>, req: Partial<Request>) {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (key: string, value: unknown) => {
      headers[key.toLowerCase()] = String(value);
    },
  } as unknown as Response;
  let nextArg: unknown = undefined;
  let called = false;
  mw(req as Request, res, ((err?: unknown) => {
    called = true;
    nextArg = err;
  }) as NextFunction);
  return { headers, called, nextArg };
}

describe('createRateLimiter', () => {
  it('allows requests up to the limit and reports the remaining allowance', () => {
    const mw = createRateLimiter({ windowMs: 60_000, max: 2, keyGenerator: () => 'k' });
    const first = callLimiter(mw, {});
    const second = callLimiter(mw, {});
    expect(first.called).toBe(true);
    expect(first.nextArg).toBeUndefined();
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    expect(second.headers['ratelimit-remaining']).toBe('0');
  });

  it('rejects over the limit with the shared rate_limited error and Retry-After', () => {
    const mw = createRateLimiter({ windowMs: 30_000, max: 1, keyGenerator: () => 'k' });
    callLimiter(mw, {});
    const blocked = callLimiter(mw, {});
    expect(blocked.nextArg).toBeInstanceOf(ApiError);
    const err = blocked.nextArg as ApiError;
    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('resets the allowance once the window has elapsed', () => {
    let clock = 1_000;
    const mw = createRateLimiter({ windowMs: 10_000, max: 1, keyGenerator: () => 'k', now: () => clock });
    expect(callLimiter(mw, {}).nextArg).toBeUndefined();
    expect(callLimiter(mw, {}).nextArg).toBeInstanceOf(ApiError);
    clock += 10_000;
    expect(callLimiter(mw, {}).nextArg).toBeUndefined();
  });

  it('tracks each key independently', () => {
    const mw = createRateLimiter({ windowMs: 60_000, max: 1 });
    const a = callLimiter(mw, { user: { sub: 'user-a' } as Request['user'] });
    const b = callLimiter(mw, { user: { sub: 'user-b' } as Request['user'] });
    expect(a.nextArg).toBeUndefined();
    expect(b.nextArg).toBeUndefined();
  });

  it('falls back to the client IP when there is no authenticated user', () => {
    const mw = createRateLimiter({ windowMs: 60_000, max: 1 });
    expect(callLimiter(mw, { ip: '10.0.0.1' }).nextArg).toBeUndefined();
    expect(callLimiter(mw, { ip: '10.0.0.1' }).nextArg).toBeInstanceOf(ApiError);
    expect(callLimiter(mw, { ip: '10.0.0.2' }).nextArg).toBeUndefined();
  });

  it('only counts methods in the allow-list and lets others pass through', () => {
    const mw = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      keyGenerator: () => 'k',
      methods: ['POST', 'DELETE'],
    });
    expect(callLimiter(mw, { method: 'GET' }).nextArg).toBeUndefined();
    expect(callLimiter(mw, { method: 'GET' }).nextArg).toBeUndefined();
    expect(callLimiter(mw, { method: 'HEAD' }).nextArg).toBeUndefined();
    expect(callLimiter(mw, { method: 'POST' }).nextArg).toBeUndefined();
    expect(callLimiter(mw, { method: 'POST' }).nextArg).toBeInstanceOf(ApiError);
    expect(callLimiter(mw, { method: 'DELETE' }).nextArg).toBeInstanceOf(ApiError);
  });
});

describe('rate limiter over HTTP', () => {
  it('returns a 429 with the shared error envelope once the limit is exceeded', async () => {
    const app = express();
    app.use(createRateLimiter({ windowMs: 60_000, max: 1 }));
    app.get('/api/ping', (_req, res) => res.json({ data: 'pong' }));
    app.use(errorHandler);
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/api/ping`);
      expect(ok.status).toBe(200);
      const blocked = await fetch(`http://127.0.0.1:${port}/api/ping`);
      expect(blocked.status).toBe(429);
      const body = (await blocked.json()) as { error: { code: string } };
      expect(body.error.code).toBe('rate_limited');
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  });
});
