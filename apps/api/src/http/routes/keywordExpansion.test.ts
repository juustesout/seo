/**
 * Keyword expansion route tests (KW4 HTTP boundary). Mounts the real router
 * over a fake container and proves: authentication, editor-only start/save,
 * viewer read, the `{ data }`/`{ error }` envelopes, edge validation, the
 * legacy-job 404 boundary and that a save derives provenance server-side.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { keywordExpansionRouter } from './keywordExpansion.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const JOB = '22222222-2222-4222-8222-222222222222';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'viewer-user' },
  'editor-token': { sub: 'editor-user' },
};
const ROLE_BY_USER: Record<string, string | undefined> = { 'viewer-user': 'viewer', 'editor-user': 'editor' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

let currentStores: Store = {};
let enqueueCalls: Array<Record<string, unknown>> = [];
let jobById: Record<string, Row | null> = {};
let upserted: Row[] = [];

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
        upsert: (rows: Row[]) => {
          upserted.push(...rows);
          return Promise.resolve({ error: null });
        },
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

function completedJob(): Row {
  return {
    id: JOB,
    project_id: PROJECT,
    job_type: 'dataforseo_keyword_research',
    status: 'completed',
    params: { seeds: ['seo tools'], methods: ['suggestions', 'related'], relatedDepth: 1, limitPerMethod: 200 },
    result: {
      seeds: ['seo tools'],
      methods: ['suggestions', 'related'],
      methodStatus: { suggestions: { status: 'success', count: 1 }, related: { status: 'failed', count: 0 } },
      candidates: [
        {
          keyword: 'seo software',
          searchVolume: 1200,
          difficulty: 40,
          cpc: 2.5,
          competition: 'HIGH',
          intent: 'commercial',
          methods: ['suggestions'],
          seeds: ['seo tools'],
        },
      ],
      count: 1,
    },
    error: null,
    queued_at: '2026-09-13T10:00:00.000Z',
    completed_at: '2026-09-13T10:00:10.000Z',
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
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string; details?: unknown } },
  };
}

beforeEach(() => {
  currentStores = defaultStores();
  enqueueCalls = [];
  jobById = {};
  upserted = [];
});

describe('keyword expansion routes', () => {
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
        registry: { getDataSource: () => ({ id: 'dataforseo' }) },
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
    app.use(`/api/projects/:projectId/keyword`, keywordExpansionRouter);
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
    const res = await request('/expansion', undefined, 'POST', { seeds: ['seo'], methods: ['suggestions'] });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe('unauthorized');
  });

  it('does not let a viewer start or save', async () => {
    const start = await request('/expansion', 'viewer-token', 'POST', { seeds: ['seo'], methods: ['suggestions'] });
    expect(start.status).toBe(403);
    const save = await request(`/expansion/${JOB}/save`, 'viewer-token', 'POST', { keywords: ['seo software'] });
    expect(save.status).toBe(403);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('lets an editor start and returns a safe run handle', async () => {
    const res = await request('/expansion', 'editor-token', 'POST', {
      seeds: ['seo tools'],
      methods: ['ideas', 'suggestions'],
      providerMinVolume: 50,
      relatedDepth: 2,
    });
    expect(res.status).toBe(202);
    expect(res.json.data).toEqual({
      jobId: JOB,
      status: 'queued',
      seeds: ['seo tools'],
      methods: ['suggestions', 'ideas'],
    });
    expect(enqueueCalls[0]).toMatchObject({
      project_id: PROJECT,
      provider: 'dataforseo',
      job_type: 'dataforseo_keyword_research',
      params: { seeds: ['seo tools'], methods: ['suggestions', 'ideas'], relatedDepth: 2, providerMinVolume: 50 },
      created_by: 'editor-user',
    });
  });

  it('rejects over-cap seeds, an empty method list and unknown methods at the edge', async () => {
    const over = await request('/expansion', 'editor-token', 'POST', {
      seeds: ['a', 'b', 'c', 'd', 'e', 'f'],
      methods: ['suggestions'],
    });
    expect(over.status).toBe(400);
    const empty = await request('/expansion', 'editor-token', 'POST', { seeds: ['seo'], methods: [] });
    expect(empty.status).toBe(400);
    const unknown = await request('/expansion', 'editor-token', 'POST', { seeds: ['seo'], methods: ['nope'] });
    expect(unknown.status).toBe(400);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('lets a viewer read a completed expansion run and its method status', async () => {
    jobById[JOB] = completedJob();
    const res = await request(`/expansion/${JOB}`, 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({
      jobId: JOB,
      status: 'completed',
      seeds: ['seo tools'],
      methods: ['suggestions', 'related'],
      methodStatus: { related: { status: 'failed', count: 0 } },
      count: 1,
      candidates: [{ keyword: 'seo software', searchVolume: 1200 }],
    });
  });

  it('applies result-view filters on read without touching the provider', async () => {
    jobById[JOB] = completedJob();
    const excluded = await request(`/expansion/${JOB}?minVolume=5000`, 'viewer-token');
    expect(excluded.status).toBe(200);
    expect((excluded.json.data as { candidates: unknown[] }).candidates).toHaveLength(0);
    const byMethod = await request(`/expansion/${JOB}?method=related`, 'viewer-token');
    expect((byMethod.json.data as { candidates: unknown[] }).candidates).toHaveLength(0);
  });

  it('does not expose a legacy KW2 job through the expansion endpoint', async () => {
    jobById[JOB] = { ...completedJob(), params: { seeds: ['seo'], keywords: [] }, result: { keywords: [] } };
    const res = await request(`/expansion/${JOB}`, 'viewer-token');
    expect(res.status).toBe(404);
  });

  it('does not expose a run from another project', async () => {
    jobById[JOB] = { ...completedJob(), project_id: OTHER_PROJECT };
    const res = await request(`/expansion/${JOB}`, 'viewer-token');
    expect(res.status).toBe(404);
  });

  it('saves a verified selection with server-derived provenance', async () => {
    jobById[JOB] = completedJob();
    const res = await request(`/expansion/${JOB}/save`, 'editor-token', 'POST', { keywords: ['seo software'] });
    expect(res.status).toBe(201);
    expect(res.json.data).toEqual({ saved: 1, skipped: 0 });
    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({ keyword: 'seo software', source: 'keyword_expansion', provider: 'dataforseo' });
    expect(upserted[0].meta).toEqual({
      discovered_via: 'keyword_expansion',
      run_job_id: JOB,
      methods: ['suggestions'],
      seeds: ['seo tools'],
    });
  });

  it('rejects a save containing a keyword outside the run', async () => {
    jobById[JOB] = completedJob();
    const res = await request(`/expansion/${JOB}/save`, 'editor-token', 'POST', {
      keywords: ['seo software', 'not in run'],
    });
    expect(res.status).toBe(400);
    expect(res.json.error?.details).toEqual({ invalid: ['not in run'] });
    expect(upserted).toHaveLength(0);
  });
});
