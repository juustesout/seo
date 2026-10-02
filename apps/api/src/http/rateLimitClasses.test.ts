/**
 * Endpoint-class rate-limit wiring tests. These mount the real class tiers on a
 * minimal express app (the production app disables rate limiting under test, so
 * the tiers cannot be exercised through `createApp` here). They prove the two
 * properties the design depends on: mutating requests are bounded while GETs
 * stay on the global budget, and each class has an isolated bucket.
 */
import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Request, Response } from 'express';
import { mountClassRateLimits } from './rateLimitClasses.js';
import { errorHandler } from '../apiErrors.js';
import type { AppConfig } from '../config.js';

const LIMITS: AppConfig['rateLimit'] = {
  disabled: false,
  windowMs: 60_000,
  max: 300,
  authMax: 600,
  strictMax: 2,
  expensiveMax: 2,
  moderateMax: 2,
};

/** Build an app with the class tiers plus the prefixes they guard, run `check`. */
async function withApp(
  rateLimit: AppConfig['rateLimit'],
  check: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  mountClassRateLimits(app, rateLimit);
  const ok = (_req: Request, res: Response) => res.json({ ok: true });
  app.get('/api/projects/:projectId/content', ok);
  app.post('/api/projects/:projectId/content', ok);
  app.get('/api/projects/:projectId/keyword', ok);
  app.post('/api/projects/:projectId/keyword', ok);
  app.get('/api/oauth/callback', ok);
  app.get('/api/account/api-keys', ok);
  app.get('/api/projects/:projectId/jobs', ok);
  app.post('/api/projects/:projectId/jobs', ok);
  app.use(errorHandler);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    await check(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

describe('class rate limits', () => {
  it('bounds mutating provider calls, shares the budget across the class, and skips GETs', async () => {
    await withApp(LIMITS, async (base) => {
      const post = (path: string) => fetch(`${base}${path}`, { method: 'POST' });
      expect((await post('/api/projects/1/keyword')).status).toBe(200);
      expect((await post('/api/projects/1/content')).status).toBe(200);
      // Third expensive write, different prefix, shares the class bucket.
      expect((await post('/api/projects/1/content')).status).toBe(429);
      // A read on the same prefix is not counted and still succeeds.
      expect((await fetch(`${base}/api/projects/1/content`)).status).toBe(200);
      expect((await fetch(`${base}/api/projects/1/keyword`)).status).toBe(200);
    });
  });

  it('bounds OAuth/credential GETs in their own class, isolated from the expensive class', async () => {
    await withApp(LIMITS, async (base) => {
      expect((await fetch(`${base}/api/oauth/callback`)).status).toBe(200);
      expect((await fetch(`${base}/api/oauth/callback`)).status).toBe(200);
      expect((await fetch(`${base}/api/oauth/callback`)).status).toBe(429);
      // Same strict class, different prefix.
      expect((await fetch(`${base}/api/account/api-keys`)).status).toBe(429);
      // A different class has its own bucket and is unaffected.
      expect((await fetch(`${base}/api/projects/1/keyword`, { method: 'POST' })).status).toBe(200);
    });
  });

  it('bounds job creation while leaving job reads alone', async () => {
    await withApp(LIMITS, async (base) => {
      const post = () => fetch(`${base}/api/projects/1/jobs`, { method: 'POST' });
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(429);
      expect((await fetch(`${base}/api/projects/1/jobs`)).status).toBe(200);
    });
  });

  it('mounts nothing when rate limiting is disabled', async () => {
    await withApp({ ...LIMITS, disabled: true }, async (base) => {
      for (let i = 0; i < 5; i += 1) {
        expect((await fetch(`${base}/api/projects/1/jobs`, { method: 'POST' })).status).toBe(200);
      }
    });
  });
});
