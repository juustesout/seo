/**
 * Knowledge API route tests (KB1 HTTP boundary).
 *
 * Mounts the real knowledgeRouter with a fake container/user and asserts the
 * wire contract: authentication, viewer vs editor role gates, canonical DTO
 * output, legacy source_type mapping (`note`/`reference` -> `text`) at the
 * boundary, the raw-body file upload contract (KB4), and safe error codes. The
 * service is stubbed so the protocol is exercised in isolation.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { KnowledgeService } from '../../services/knowledgeService.js';
import { knowledgeRouter } from './knowledge.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'v-user' },
  'editor-token': { sub: 'e-user' },
};

const ROLE_BY_USER: Record<string, string> = { 'v-user': 'viewer', 'e-user': 'editor' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

const sourceDto = {
  id: SOURCE,
  project_id: PROJECT,
  source_type: 'text',
  name: 'My note',
  url: null,
  status: 'queued',
  error: null,
  chunk_count: 0,
  last_indexed_at: null,
  original_filename: null,
  content_type: null,
  size_bytes: null,
  created_at: '2026-09-08T00:00:00.000Z',
  updated_at: '2026-09-08T00:00:00.000Z',
};

let server: Server;
let base = '';

function bearer(token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function request(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const method = init.method ?? 'GET';
  const res = await fetch(`${base}${path}`, {
    method,
    headers: bearer(init.token),
    body: method !== 'GET' && init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
}

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
      registry: { listKnowledge: () => [{ id: 'qdrant', name: 'Qdrant' }], getKnowledge: () => ({ id: 'qdrant' }) },
      sb: {},
      jobStore: {},
    };
    (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
    next();
  });
  app.use(
    '/api/projects/:projectId/knowledge/sources/upload',
    express.raw({ type: () => true, limit: '12mb' }),
  );
  app.use(`/api/projects/:projectId/knowledge`, knowledgeRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${PROJECT}/knowledge`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const summary = {
  total: 1,
  draft: 0,
  queued: 1,
  processing: 0,
  ready: 0,
  failed: 0,
  total_chunks: 0,
};

const detailDto = { ...sourceDto, preview: { text: 'My note body', truncated: false, characters: 12 } };

const searchHit = {
  source_id: SOURCE,
  source_name: 'My note',
  source_type: 'text',
  source_url: null,
  managed: true,
  chunk_index: 0,
  content: 'My note body',
  score: 0.87,
};

beforeEach(() => {
  vi.spyOn(KnowledgeService.prototype, 'configuredReason').mockReturnValue(null);
  vi.spyOn(KnowledgeService.prototype, 'search').mockResolvedValue({
    project_id: PROJECT,
    query: 'seo',
    limit: 10,
    results: [searchHit],
    diagnostics: { result_count: 1, provider: 'qdrant', search_duration_ms: 3 },
  } as never);
  vi.spyOn(KnowledgeService.prototype, 'listSources').mockResolvedValue({
    items: [sourceDto],
    total: 1,
    limit: 50,
    offset: 0,
    summary,
  } as never);
  vi.spyOn(KnowledgeService.prototype, 'getSourceDetail').mockResolvedValue(detailDto as never);
  vi.spyOn(KnowledgeService.prototype, 'createSource').mockResolvedValue({
    source: sourceDto,
    job: { id: 'job-1' },
  } as never);
  vi.spyOn(KnowledgeService.prototype, 'createFileSource').mockResolvedValue({
    source: sourceDto,
    job: null,
  } as never);
  vi.spyOn(KnowledgeService.prototype, 'enqueueIngest').mockResolvedValue({ id: 'job-2' } as never);
  vi.spyOn(KnowledgeService.prototype, 'enqueueDelete').mockResolvedValue({ id: 'job-3' } as never);
  vi.spyOn(KnowledgeService.prototype, 'updateRefreshPolicy').mockResolvedValue(sourceDto as never);
  vi.spyOn(KnowledgeService.prototype, 'enqueueRefresh').mockResolvedValue({ id: 'job-refresh' } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('knowledge route authentication + role gates', () => {
  it('requires authentication', async () => {
    const res = await request('/sources');
    expect(res.status).toBe(401);
  });

  it('lets a viewer list sources but not create them', async () => {
    const list = await request('/sources', { token: 'viewer-token' });
    expect(list.status).toBe(200);

    const create = await request('/sources', {
      method: 'POST',
      token: 'viewer-token',
      body: { name: 'Note', text: 'hello' },
    });
    expect(create.status).toBe(403);
  });

  it('lets an editor create, reindex, ingest and delete', async () => {
    expect((await request('/sources', { method: 'POST', token: 'editor-token', body: { name: 'N', text: 'x' } })).status).toBe(202);
    expect((await request(`/sources/${SOURCE}/reindex`, { method: 'POST', token: 'editor-token', body: {} })).status).toBe(202);
    expect((await request(`/sources/${SOURCE}/ingest`, { method: 'POST', token: 'editor-token', body: {} })).status).toBe(202);
    expect((await request(`/sources/${SOURCE}`, { method: 'DELETE', token: 'editor-token' })).status).toBe(202);
  });
});

describe('knowledge ingest route', () => {
  it('requires the editor role', async () => {
    const res = await request(`/sources/${SOURCE}/ingest`, { method: 'POST', token: 'viewer-token', body: {} });
    expect(res.status).toBe(403);
    expect(vi.mocked(KnowledgeService.prototype.enqueueIngest)).not.toHaveBeenCalled();
  });

  it('scopes the ingest to the project and the calling user', async () => {
    const res = await request(`/sources/${SOURCE}/ingest`, { method: 'POST', token: 'editor-token', body: {} });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ data: { job: { id: 'job-2' } } });
    expect(vi.mocked(KnowledgeService.prototype.enqueueIngest)).toHaveBeenLastCalledWith(PROJECT, SOURCE, 'e-user');
  });

  it('surfaces the lifecycle conflict when the source is already queued/processing', async () => {
    vi.mocked(KnowledgeService.prototype.enqueueIngest).mockRejectedValue(
      new ApiError(409, 'conflict', 'The source changed while queueing ingestion. Try again.') as never,
    );
    const res = await request(`/sources/${SOURCE}/ingest`, { method: 'POST', token: 'editor-token', body: {} });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: { code: 'conflict' } });
  });

  it('reports an unconfigured fetcher as a safe capability error', async () => {
    vi.mocked(KnowledgeService.prototype.enqueueIngest).mockRejectedValue(
      new ApiError(503, 'knowledge_jina_not_configured', 'URL fetching is not configured on this server.') as never,
    );
    const res = await request(`/sources/${SOURCE}/ingest`, { method: 'POST', token: 'editor-token', body: {} });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ error: { code: 'knowledge_jina_not_configured' } });
  });
});

describe('knowledge create boundary mapping', () => {
  it('normalizes legacy note/reference source types to canonical text', async () => {
    const create = vi.mocked(KnowledgeService.prototype.createSource);
    await request('/sources', { method: 'POST', token: 'editor-token', body: { name: 'Note', source_type: 'note', text: 'hello' } });
    expect(create).toHaveBeenLastCalledWith(PROJECT, 'e-user', expect.objectContaining({ sourceType: 'text' }));

    await request('/sources', { method: 'POST', token: 'editor-token', body: { name: 'Ref', source_type: 'reference', text: 'hello' } });
    expect(create).toHaveBeenLastCalledWith(PROJECT, 'e-user', expect.objectContaining({ sourceType: 'text' }));
  });

  it('passes canonical url/type through unchanged', async () => {
    const create = vi.mocked(KnowledgeService.prototype.createSource);
    await request('/sources', { method: 'POST', token: 'editor-token', body: { name: 'Ref', source_type: 'url', url: 'https://ref.example' } });
    expect(create).toHaveBeenLastCalledWith(PROJECT, 'e-user', expect.objectContaining({ sourceType: 'url' }));
  });

  it('rejects unknown source types at the edge', async () => {
    const res = await request('/sources', { method: 'POST', token: 'editor-token', body: { name: 'Bad', source_type: 'bogus' } });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe('validation_error');
  });

  it('surfaces a file type error unchanged', async () => {
    vi.mocked(KnowledgeService.prototype.createSource).mockRejectedValue(
      new ApiError(400, 'knowledge_file_type_not_allowed', 'This file type is not supported.') as never,
    );
    const res = await request('/sources', { method: 'POST', token: 'editor-token', body: { name: 'F', source_type: 'file', url: 'https://f.example' } });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: 'knowledge_file_type_not_allowed' } });
  });
});

describe('knowledge file upload route', () => {
  async function upload(init: { token?: string; filename?: string; contentType?: string; body?: Uint8Array | string; qs?: string } = {}) {
    const headers: Record<string, string> = { 'content-type': init.contentType ?? 'text/plain' };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const q = init.qs ?? (init.filename !== undefined ? `?filename=${encodeURIComponent(init.filename)}` : '');
    const res = await fetch(`${base}/sources/upload${q}`, { method: 'POST', headers, body: init.body as BodyInit });
    return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
  }

  it('requires the editor role and never uploads for a viewer', async () => {
    const res = await upload({ token: 'viewer-token', filename: 'a.txt', body: 'hello' });
    expect(res.status).toBe(403);
    expect(vi.mocked(KnowledgeService.prototype.createFileSource)).not.toHaveBeenCalled();
  });

  it('passes the sanitized project, filename, content type and bytes to the service', async () => {
    const res = await upload({ token: 'editor-token', filename: 'report.PDF', contentType: 'application/pdf', body: new TextEncoder().encode('%PDF-1.4 x') });
    expect(res.status).toBe(201);
    expect(vi.mocked(KnowledgeService.prototype.createFileSource)).toHaveBeenLastCalledWith(
      PROJECT,
      'e-user',
      expect.objectContaining({ filename: 'report.PDF', contentType: 'application/pdf' }),
    );
  });

  it('rejects an empty or bodyless upload', async () => {
    const res = await upload({ token: 'editor-token', filename: 'a.txt', body: new Uint8Array() });
    expect(res.status).toBe(400);
  });

  it('rejects a missing filename', async () => {
    const res = await upload({ token: 'editor-token', qs: '', body: 'hello' });
    expect(res.status).toBe(400);
  });

  it('surfaces the storage failure code from the service', async () => {
    vi.mocked(KnowledgeService.prototype.createFileSource).mockRejectedValue(
      new ApiError(502, 'knowledge_file_storage_failed', 'The file could not be stored. Try again later.') as never,
    );
    const res = await upload({ token: 'editor-token', filename: 'a.txt', body: 'hello' });
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ error: { code: 'knowledge_file_storage_failed' } });
  });
});

describe('knowledge source library (KB5)', () => {
  it('passes validated filter/sort/pagination to the service and returns the page', async () => {
    const res = await request('/sources?type=file&status=ready&search=guide&sort=name_asc&limit=10&offset=20', {
      token: 'viewer-token',
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(KnowledgeService.prototype.listSources)).toHaveBeenLastCalledWith(PROJECT, {
      type: 'file',
      status: 'ready',
      search: 'guide',
      sort: 'name_asc',
      limit: 10,
      offset: 20,
    });
    expect(res.json).toMatchObject({
      data: { total: 1, limit: 50, offset: 0, items: [{ id: SOURCE }], summary: { total: 1 } },
    });
  });

  it('applies bounded defaults when no query is given', async () => {
    await request('/sources', { token: 'viewer-token' });
    expect(vi.mocked(KnowledgeService.prototype.listSources)).toHaveBeenLastCalledWith(PROJECT, {
      sort: 'updated_desc',
      limit: 50,
      offset: 0,
    });
  });

  it('rejects invalid type, status, sort and over-max limit at the edge', async () => {
    for (const qs of ['type=bogus', 'status=nope', 'sort=id_asc', 'limit=1000', 'offset=-1']) {
      const res = await request(`/sources?${qs}`, { token: 'viewer-token' });
      expect(res.status, qs).toBe(400);
      expect((res.json as { error: { code: string } }).error.code).toBe('validation_error');
    }
  });

  it('returns one project-scoped source detail with its bounded preview', async () => {
    const res = await request(`/sources/${SOURCE}`, { token: 'viewer-token' });
    expect(res.status).toBe(200);
    expect(vi.mocked(KnowledgeService.prototype.getSourceDetail)).toHaveBeenLastCalledWith(PROJECT, SOURCE);
    expect(res.json).toMatchObject({
      data: { id: SOURCE, project_id: PROJECT, preview: { text: 'My note body', truncated: false } },
    });
  });

  it('hides a foreign/unknown source as 404, never an existence oracle', async () => {
    vi.mocked(KnowledgeService.prototype.getSourceDetail).mockRejectedValue(
      ApiError.notFound('Knowledge source not found in this project') as never,
    );
    const res = await request(`/sources/${SOURCE}`, { token: 'viewer-token' });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: { code: 'not_found' } });
  });

  it('rejects a malformed source id before any lookup', async () => {
    const res = await request('/sources/not-a-uuid', { token: 'viewer-token' });
    expect(res.status).toBe(400);
    expect(vi.mocked(KnowledgeService.prototype.getSourceDetail)).not.toHaveBeenCalled();
  });
});

describe('knowledge retrieval route (KB6)', () => {
  it('lets a viewer search and passes a validated request to the service', async () => {
    const res = await request('/search', { method: 'POST', token: 'viewer-token', body: { query: 'seo' } });
    expect(res.status).toBe(200);
    expect(vi.mocked(KnowledgeService.prototype.search)).toHaveBeenLastCalledWith(PROJECT, {
      query: 'seo',
      limit: undefined,
      sourceTypes: undefined,
      sourceIds: undefined,
    });
    expect(res.json).toMatchObject({
      data: {
        project_id: PROJECT,
        limit: 10,
        diagnostics: { result_count: 1, provider: 'qdrant' },
        results: [{ source_id: SOURCE, managed: true, score: 0.87 }],
      },
    });
  });

  it('lets an editor search too', async () => {
    const res = await request('/search', { method: 'POST', token: 'editor-token', body: { query: 'seo' } });
    expect(res.status).toBe(200);
  });

  it('passes allowlisted filters and the bounded limit through', async () => {
    const res = await request('/search', {
      method: 'POST',
      token: 'viewer-token',
      body: { query: 'seo', limit: 5, source_types: ['url', 'file'], source_ids: [SOURCE] },
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(KnowledgeService.prototype.search)).toHaveBeenLastCalledWith(PROJECT, {
      query: 'seo',
      limit: 5,
      sourceTypes: ['url', 'file'],
      sourceIds: [SOURCE],
    });
  });

  it('rejects an invalid query at the edge', async () => {
    for (const body of [{}, { query: '' }, { query: '   ' }, { query: 'x'.repeat(1001) }, { query: 42 }]) {
      const res = await request('/search', { method: 'POST', token: 'viewer-token', body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((res.json as { error: { code: string } }).error.code).toBe('validation_error');
    }
    expect(vi.mocked(KnowledgeService.prototype.search)).not.toHaveBeenCalled();
  });

  it('rejects over-max or malformed limits and filters', async () => {
    for (const body of [
      { query: 'seo', limit: 0 },
      { query: 'seo', limit: 51 },
      { query: 'seo', source_types: ['bogus'] },
      { query: 'seo', source_ids: ['not-a-uuid'] },
    ]) {
      const res = await request('/search', { method: 'POST', token: 'viewer-token', body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((res.json as { error: { code: string } }).error.code).toBe('validation_error');
    }
  });

  it('surfaces a safe not-configured state', async () => {
    vi.mocked(KnowledgeService.prototype.search).mockRejectedValue(
      ApiError.notConfigured('Knowledge search is not available.') as never,
    );
    const res = await request('/search', { method: 'POST', token: 'viewer-token', body: { query: 'seo' } });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ error: { code: 'not_configured' } });
  });

  it('surfaces a safe provider failure without raw internals', async () => {
    vi.mocked(KnowledgeService.prototype.search).mockRejectedValue(
      new ApiError(502, 'knowledge_search_failed', 'Knowledge search is temporarily unavailable.') as never,
    );
    const res = await request('/search', { method: 'POST', token: 'viewer-token', body: { query: 'seo' } });
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({
      error: { code: 'knowledge_search_failed', message: 'Knowledge search is temporarily unavailable.' },
    });
    expect(JSON.stringify(res.json)).not.toContain('secret');
  });

  it('never returns raw vector ids or provider payloads', async () => {
    const res = await request('/search', { method: 'POST', token: 'viewer-token', body: { query: 'seo' } });
    const hit = (res.json as { data: { results: Array<Record<string, unknown>> } }).data.results[0]!;
    expect(hit.payload).toBeUndefined();
    expect(hit.id).toBeUndefined();
  });
});

describe('knowledge refresh + policy routes (KB7)', () => {
  it('gates both actions behind the editor role', async () => {
    const patch = await request(`/sources/${SOURCE}`, {
      method: 'PATCH',
      token: 'viewer-token',
      body: { refresh_policy: 'daily' },
    });
    const refresh = await request(`/sources/${SOURCE}/refresh`, { method: 'POST', token: 'viewer-token', body: {} });
    expect(patch.status).toBe(403);
    expect(refresh.status).toBe(403);
    expect(vi.mocked(KnowledgeService.prototype.updateRefreshPolicy)).not.toHaveBeenCalled();
    expect(vi.mocked(KnowledgeService.prototype.enqueueRefresh)).not.toHaveBeenCalled();
  });

  it('lets an editor change the policy and returns the updated source', async () => {
    const res = await request(`/sources/${SOURCE}`, {
      method: 'PATCH',
      token: 'editor-token',
      body: { refresh_policy: 'weekly' },
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(KnowledgeService.prototype.updateRefreshPolicy)).toHaveBeenLastCalledWith(PROJECT, SOURCE, 'weekly');
    expect(res.json).toMatchObject({ data: { source: { id: SOURCE } } });
  });

  it('rejects an invalid policy at the edge without calling the service', async () => {
    for (const body of [{ refresh_policy: 'hourly' }, { refresh_policy: '' }, {}]) {
      const res = await request(`/sources/${SOURCE}`, { method: 'PATCH', token: 'editor-token', body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((res.json as { error: { code: string } }).error.code).toBe('validation_error');
    }
    expect(vi.mocked(KnowledgeService.prototype.updateRefreshPolicy)).not.toHaveBeenCalled();
  });

  it('queues an explicit refresh for an editor and returns the job', async () => {
    const res = await request(`/sources/${SOURCE}/refresh`, { method: 'POST', token: 'editor-token', body: {} });
    expect(res.status).toBe(202);
    expect(vi.mocked(KnowledgeService.prototype.enqueueRefresh)).toHaveBeenLastCalledWith(PROJECT, SOURCE, 'e-user');
    expect(res.json).toMatchObject({ data: { job: { id: 'job-refresh' } } });
  });

  it('surfaces service conflicts and invalid URLs as safe errors', async () => {
    vi.mocked(KnowledgeService.prototype.enqueueRefresh).mockRejectedValue(
      ApiError.conflict('Only URL sources can be refreshed.') as never,
    );
    const conflict = await request(`/sources/${SOURCE}/refresh`, { method: 'POST', token: 'editor-token', body: {} });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ error: { code: 'conflict' } });

    vi.mocked(KnowledgeService.prototype.enqueueRefresh).mockRejectedValue(
      new ApiError(400, 'knowledge_invalid_url', "That URL can't be used.") as never,
    );
    const invalid = await request(`/sources/${SOURCE}/refresh`, { method: 'POST', token: 'editor-token', body: {} });
    expect(invalid.status).toBe(400);
    expect(invalid.json).toMatchObject({ error: { code: 'knowledge_invalid_url' } });
  });

  it('rejects a malformed source id before any lookup', async () => {
    const patch = await request('/sources/not-a-uuid', {
      method: 'PATCH',
      token: 'editor-token',
      body: { refresh_policy: 'daily' },
    });
    const refresh = await request('/sources/not-a-uuid/refresh', { method: 'POST', token: 'editor-token', body: {} });
    expect(patch.status).toBe(400);
    expect(refresh.status).toBe(400);
    expect(vi.mocked(KnowledgeService.prototype.updateRefreshPolicy)).not.toHaveBeenCalled();
    expect(vi.mocked(KnowledgeService.prototype.enqueueRefresh)).not.toHaveBeenCalled();
  });
});
