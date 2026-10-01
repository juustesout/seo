/**
 * App-perimeter tests: the security headers and the fail-closed CORS policy
 * are asserted at the real HTTP boundary (health is mounted before any
 * container/auth middleware, so no Supabase is needed).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

let server: Server;
let base: string;
const prevCors = process.env.CORS_ORIGINS;

beforeAll(async () => {
  process.env.CORS_ORIGINS = 'https://app.example';
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (prevCors === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = prevCors;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('app security perimeter', () => {
  it('sets baseline security headers on every response', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('does not reflect a non-allow-listed origin (CORS fails closed)', async () => {
    const res = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reflects an allow-listed origin with credentials', async () => {
    const res = await fetch(`${base}/api/health`, { headers: { origin: 'https://app.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
