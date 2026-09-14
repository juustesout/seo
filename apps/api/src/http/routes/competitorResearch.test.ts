/**
 * Competitor research route tests (KW3 HTTP boundary).
 *
 * Mounts the real competitorResearchRouter over a fake container so the wire
 * contract is tested end to end: authentication, editor-only start, viewer read,
 * the `{ data }` envelope, validation, honest not-configured failures and
 * project isolation. Error responses must never leak provider internals.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { competitorDiscoveryScope, competitorGapScope, scopeKeyOf } from '../../services/sourceScope.js';
import { competitorResearchRouter } from './competitorResearch.js';

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
    seo_domains: [{ id: 'dom-1', project_id: PROJECT, domain: 'example.com', is_primary: true }],
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
    json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } },
  };
}

beforeEach(() => {
  currentStores = defaultStores();
  registered = true;
  enqueueCalls = [];
  jobById = {};
});

describe('competitor research routes', () => {
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
    app.use(`/api/projects/:projectId/keyword`, competitorResearchRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${PROJECT}/keyword`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects an anonymous discovery start', async () => {
    const res = await request('/competitors', undefined, 'POST', {});
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe('unauthorized');
  });

  it('does not let a viewer start discovery', async () => {
    const res = await request('/competitors', 'viewer-token', 'POST', {});
    expect(res.status).toBe(403);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('lets an editor start discovery and returns a safe run handle', async () => {
    const res = await request('/competitors', 'editor-token', 'POST', {});
    expect(res.status).toBe(202);
    expect(res.json.data).toEqual({
      jobId: JOB,
      status: 'queued',
      mode: 'discover',
      domain: 'example.com',
      reused: false,
      snapshotId: null,
    });
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toMatchObject({
      project_id: PROJECT,
      provider: 'dataforseo',
      job_type: 'competitor_research',
      params: { mode: 'discover', domain: 'example.com' },
      created_by: 'editor-user',
    });
  });

  it('lets an editor start a gap analysis', async () => {
    const res = await request('/competitor-gap', 'editor-token', 'POST', { competitors: ['rival.com', 'other.com'] });
    expect(res.status).toBe(202);
    expect(res.json.data).toEqual({
      jobId: JOB,
      status: 'queued',
      mode: 'gap',
      domain: 'example.com',
      competitors: ['rival.com', 'other.com'],
      reused: false,
      snapshotId: null,
    });
    expect(enqueueCalls[0]).toMatchObject({
      job_type: 'competitor_research',
      params: { mode: 'gap', domain: 'example.com', competitors: ['rival.com', 'other.com'] },
    });
  });

  it('rejects an over-cap competitor selection at the edge', async () => {
    const res = await request('/competitor-gap', 'editor-token', 'POST', {
      competitors: ['a.com', 'b.com', 'c.com', 'd.com'],
    });
    expect(res.status).toBe(400);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('rejects an empty competitor selection', async () => {
    const res = await request('/competitor-gap', 'editor-token', 'POST', { competitors: [] });
    expect(res.status).toBe(400);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('reports not configured when the provider is not registered', async () => {
    registered = false;
    const res = await request('/competitors', 'editor-token', 'POST', {});
    expect(res.status).toBe(503);
    expect(res.json.error?.code).toBe('not_configured');
    expect(enqueueCalls).toHaveLength(0);
  });

  it('lets a viewer read one specific run', async () => {
    jobById[JOB] = {
      id: JOB,
      project_id: PROJECT,
      job_type: 'competitor_research',
      status: 'completed',
      params: { mode: 'discover', domain: 'example.com' },
      result: {
        mode: 'discover',
        domain: 'example.com',
        count: 1,
        competitors: [{ domain: 'rival.com', sharedKeywords: 10, keywordsCount: 20, avgPosition: 5, etv: 100 }],
      },
      error: null,
      queued_at: '2026-09-13T10:00:00.000Z',
      completed_at: '2026-09-13T10:00:10.000Z',
    };
    const res = await request(`/competitors/${JOB}`, 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({
      jobId: JOB,
      mode: 'discover',
      status: 'completed',
      domain: 'example.com',
      count: 1,
      candidates: [{ domain: 'rival.com', sharedKeywords: 10, keywordsCount: 20, avgPosition: 5, etv: 100 }],
    });
  });

  it('returns the current discovery snapshot for a viewer without starting a job', async () => {
    const scope = competitorDiscoveryScope({ domain: 'example.com' });
    currentStores.seo_source_snapshots = [
      {
        id: 'snap-1',
        project_id: PROJECT,
        type: 'competitor_discovery',
        provider: 'dataforseo',
        scope,
        scope_key: scopeKeyOf(scope),
        data: { competitors: [{ domain: 'rival.com' }], total: 1 },
        fetched_at: new Date().toISOString(),
        source_job_id: null,
      },
    ];
    const res = await request('/competitors/snapshot', 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({
      id: 'snap-1',
      type: 'competitor_discovery',
      count: 1,
      freshness: { state: 'fresh' },
    });
    expect(enqueueCalls).toHaveLength(0);
  });

  it('returns null when no discovery snapshot exists yet', async () => {
    const res = await request('/competitors/snapshot', 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toBeNull();
    expect(enqueueCalls).toHaveLength(0);
  });

  it('returns the current gap snapshot for the selected competitors', async () => {
    const scope = competitorGapScope({ domain: 'example.com', competitors: ['rival.com'] });
    currentStores.seo_source_snapshots = [
      {
        id: 'snap-2',
        project_id: PROJECT,
        type: 'competitor_gap',
        provider: 'dataforseo',
        scope,
        scope_key: scopeKeyOf(scope),
        data: { gaps: [{ keyword: 'blue widgets', competitorDomain: 'rival.com' }], total: 1 },
        fetched_at: new Date().toISOString(),
        source_job_id: null,
      },
    ];
    const res = await request('/competitor-gap/snapshot?competitors=rival.com', 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ id: 'snap-2', type: 'competitor_gap', count: 1 });
    expect(enqueueCalls).toHaveLength(0);
  });

  it('does not return a run from another project', async () => {
    jobById[JOB] = {
      id: JOB,
      project_id: OTHER_PROJECT,
      job_type: 'competitor_research',
      status: 'completed',
      params: { mode: 'discover', domain: 'example.com' },
      result: { mode: 'discover', domain: 'example.com', competitors: [] },
      queued_at: '2026-09-13T10:00:00.000Z',
      completed_at: '2026-09-13T10:00:10.000Z',
    };
    const res = await request(`/competitors/${JOB}`, 'viewer-token');
    expect(res.status).toBe(404);
  });

  it('does not return a non-competitor job', async () => {
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
    const res = await request(`/competitors/${JOB}`, 'viewer-token');
    expect(res.status).toBe(404);
  });
});
