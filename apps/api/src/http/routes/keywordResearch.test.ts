/**
 * Keyword research route tests (KW2 HTTP boundary).
 *
 * Mounts the real keywordResearchRouter over a fake container so the wire
 * contract is tested end to end: authentication, editor-only start, viewer read,
 * the `{ data }` envelope, validation, honest not-configured/provider failures
 * and project isolation. Error responses must never leak provider internals.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { keywordResearchRouter } from './keywordResearch.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const JOB = '22222222-2222-4222-8222-222222222222';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'viewer-user' },
  'editor-token': { sub: 'editor-user' },
  'norole-token': { sub: 'no-role-user' },
};
const ROLE_BY_USER: Record<string, string | undefined> = { 'viewer-user': 'viewer', 'editor-user': 'editor' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

let currentStores: Store = {};
let registered = true;
let enqueueCalls: Array<Record<string, unknown>> = [];
let jobById: Record<string, Row | null> = {};

function fakeSb() {
  return {
    from(table: string) {
      const all = currentStores[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: all.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      };
      return builder;
    },
  };
}

function defaultStores(): Store {
  return {
    seo_integrations: [{ id: 'int-1', project_id: PROJECT, provider_type: 'dataforseo', status: 'connected' }],
    seo_data_sources: [{ id: 'ds-1', project_id: PROJECT, provider_type: 'dataforseo' }],
  };
}

let server: Server;
let base = '';

async function request(path: string, token?: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } } };
}

beforeEach(() => {
  currentStores = defaultStores();
  registered = true;
  enqueueCalls = [];
  jobById = {};
});

describe('keyword research routes', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      (req as unknown as { container: unknown }).container = {
        access: {
          requireRole: async (userId: string, _projectId: string, minRole: string) => {
            const role = ROLE_BY_USER[userId];
            if (!role) throw ApiError.forbidden('You do not have access to this project');
            if ((ROLE_ORDER[role] ?? -1) < ROLE_ORDER[minRole]) {
              throw ApiError.forbidden(`This action requires the ${minRole} role`);
            }
          },
        },
        config: { env: {} },
        sb: fakeSb(),
        registry: { getDataSource: () => (registered ? { id: 'dataforseo' } : undefined) },
        jobStore: {
          enqueue: async (input: Record<string, unknown>) => {
            enqueueCalls.push(input);
            return { id: JOB, status: 'queued', project_id: PROJECT, job_type: input.job_type, params: input.params };
          },
          get: async (id: string) => jobById[id] ?? null,
        },
      };
      (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
      next();
    });
    app.use(`/api/projects/:projectId/keyword`, keywordResearchRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${PROJECT}/keyword`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects an anonymous start', async () => {
    const res = await request('/research', undefined, 'POST', { seed: 'seo' });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe('unauthorized');
  });

  it('does not let a viewer start research', async () => {
    const res = await request('/research', 'viewer-token', 'POST', { seed: 'seo' });
    expect(res.status).toBe(403);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('lets an editor start research and returns a safe run handle', async () => {
    const res = await request('/research', 'editor-token', 'POST', { seed: ' seo tools ' });
    expect(res.status).toBe(202);
    expect(res.json.data).toEqual({ jobId: JOB, status: 'queued', seed: 'seo tools' });
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toMatchObject({
      project_id: PROJECT,
      provider: 'dataforseo',
      job_type: 'dataforseo_keyword_research',
      params: { seeds: ['seo tools'] },
      created_by: 'editor-user',
    });
  });

  it('rejects an empty seed with a validation error', async () => {
    const res = await request('/research', 'editor-token', 'POST', { seed: '   ' });
    expect(res.status).toBe(400);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('reports not configured when the provider is not registered', async () => {
    registered = false;
    const res = await request('/research', 'editor-token', 'POST', { seed: 'seo' });
    expect(res.status).toBe(503);
    expect(res.json.error?.code).toBe('not_configured');
    expect(enqueueCalls).toHaveLength(0);
  });

  it('refuses to start when no dataforseo integration is connected', async () => {
    currentStores.seo_integrations = [];
    const res = await request('/research', 'editor-token', 'POST', { seed: 'seo' });
    expect(res.status).toBe(400);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('lets a viewer read one specific run', async () => {
    jobById[JOB] = {
      id: JOB,
      project_id: PROJECT,
      job_type: 'dataforseo_keyword_research',
      status: 'completed',
      params: { seeds: ['seo tools'] },
      result: { seed: 'seo tools', results: 1, keywords: [{ keyword: 'seo software', searchVolume: 10, difficulty: 5, cpc: 1 }] },
      error: null,
      queued_at: '2026-09-13T10:00:00.000Z',
      completed_at: '2026-09-13T10:00:10.000Z',
    };
    const res = await request(`/research/${JOB}`, 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({
      jobId: JOB,
      seed: 'seo tools',
      status: 'completed',
      results: 1,
      keywords: [{ keyword: 'seo software', searchVolume: 10, difficulty: 5, cpc: 1 }],
    });
  });

  it('does not return a run from another project', async () => {
    jobById[JOB] = {
      id: JOB,
      project_id: OTHER_PROJECT,
      job_type: 'dataforseo_keyword_research',
      status: 'completed',
      params: { seeds: ['seo'] },
      result: { keywords: [] },
      queued_at: '2026-09-13T10:00:00.000Z',
      completed_at: '2026-09-13T10:00:10.000Z',
    };
    const res = await request(`/research/${JOB}`, 'viewer-token');
    expect(res.status).toBe(404);
  });

  it('does not return a non-research job', async () => {
    jobById[JOB] = {
      id: JOB,
      project_id: PROJECT,
      job_type: 'gsc_sync',
      status: 'completed',
      params: {},
      result: {},
      queued_at: '2026-09-13T10:00:00.000Z',
      completed_at: '2026-09-13T10:00:10.000Z',
    };
    const res = await request(`/research/${JOB}`, 'viewer-token');
    expect(res.status).toBe(404);
  });
});
