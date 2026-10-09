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
    server = app.listen(0, () => resolve());
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

  it('reports liveness without disclosing configured integrations', async () => {
    const res = await fetch(`${base}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.configured).toBeUndefined();
  });
});

describe('request correlation', () => {
  it('generates and echoes a request id on every response', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
  });

  it('propagates a safe caller-supplied request id', async () => {
    const res = await fetch(`${base}/api/health`, { headers: { 'x-request-id': 'req-abc.123' } });
    expect(res.headers.get('x-request-id')).toBe('req-abc.123');
  });

  it('does not reflect an unsafe request id (regenerates instead)', async () => {
    const res = await fetch(`${base}/api/health`, { headers: { 'x-request-id': 'bad~id<x>' } });
    const echoed = res.headers.get('x-request-id');
    expect(echoed).not.toBe('bad~id<x>');
    expect(echoed).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
  });

  it('includes the request id in an error body for support correlation', async () => {
    const res = await fetch(`${base}/api/definitely-not-a-route`, {
      headers: { 'x-request-id': 'trace-me-42' },
    });
    const body = (await res.json()) as { error?: { request_id?: string } };
    expect(body.error?.request_id).toBe('trace-me-42');
  });
});
