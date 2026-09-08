/**
 * Writer API route tests (W6 HTTP layer).
 *
 * These tests mount the real writerRouter with a fake container/user and assert
 * the wire contract: authentication, role gates (viewer read-only vs editor
 * start/approve), project/content existence checks, W3 approval semantics
 * (malformed runId/decision -> 400, unknown run -> 404, wrong state -> 409),
 * the safe WriterRunDto envelope and the "no automatic content save" boundary
 * (the writer flow never reaches ContentService.update/create).
 *
 * Run binding/isolation is enforced in the SEO Core WriterRunService and is
 * tested in writerRunService.test.ts; here the service methods are stubbed so
 * the protocol and authorization are exercised in isolation.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { ContentService } from '../../services/contentService.js';
import { WriterRunService } from '../../services/writerRunService.js';
import { writerRouter } from './writer.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CONTENT = '33333333-3333-4333-8333-333333333333';
const RUN = 'wr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'v-user' },
  'editor-token': { sub: 'e-user' },
  'admin-token': { sub: 'a-user' },
};

const ROLE_BY_USER: Record<string, string> = { 'v-user': 'viewer', 'e-user': 'editor', 'a-user': 'admin' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

let server: Server;
let base = '';

function dto(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    runId: RUN,
    projectId: PROJECT,
    contentId: CONTENT,
    status: 'awaiting_approval',
    plan: {
      title: 'Proposed title',
      metaDescription: null,
      introductionPurpose: 'Frame.',
      sections: [{ heading: 'Section one', keyPoints: ['point'], suggestedKeywords: [] }],
    },
    review: null,
    note: null,
    createdAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

const contentRow = { id: CONTENT, project_id: PROJECT, title: 'Existing title', target_keyword: 'seo keyword' };

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
  const json = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, json };
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
      sb: {},
    };
    (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
    next();
  });
  app.use(`/api/projects/:projectId/content/:contentId/writer`, writerRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${PROJECT}/content/${CONTENT}/writer`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  vi.spyOn(ContentService.prototype, 'get').mockResolvedValue(contentRow as never);
  vi.spyOn(WriterRunService.prototype, 'start').mockResolvedValue(dto() as never);
  vi.spyOn(WriterRunService.prototype, 'getRun').mockResolvedValue(dto() as never);
  vi.spyOn(WriterRunService.prototype, 'decide').mockResolvedValue(dto({ status: 'writing' }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writer API - authorization', () => {
  it.each(['POST /', 'GET /:runId', 'POST /:runId/approval'])('401 when unauthenticated', async (route) => {
    const [method, pathTemplate] = route.split(' ') as [string, string];
    const path = pathTemplate === 'POST /' ? '' : pathTemplate === '/:runId' ? `/${RUN}` : `/${RUN}/approval`;
    const res = await request(path, { method, body: {} });
    expect(res.status).toBe(401);
    expect((res.json as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('403: viewer cannot start', async () => {
    const res = await request('', { method: 'POST', token: 'viewer-token', body: { instruction: 'Write' } });
    expect(res.status).toBe(403);
  });

  it('403: viewer cannot approve', async () => {
    const res = await request(`/${RUN}/approval`, { method: 'POST', token: 'viewer-token', body: { decision: 'approve' } });
    expect(res.status).toBe(403);
  });

  it('403: viewer cannot reject', async () => {
    const res = await request(`/${RUN}/approval`, { method: 'POST', token: 'viewer-token', body: { decision: 'reject' } });
    expect(res.status).toBe(403);
  });

  it('editor can start (201) and approve (200)', async () => {
    const start = await request('', { method: 'POST', token: 'editor-token', body: { instruction: 'Write it' } });
    expect(start.status).toBe(201);
    expect((start.json as { data: { status: string } }).data.status).toBe('awaiting_approval');

    const approve = await request(`/${RUN}/approval`, { method: 'POST', token: 'editor-token', body: { decision: 'approve' } });
    expect(approve.status).toBe(200);
    expect((approve.json as { data: { status: string } }).data.status).toBe('writing');
  });

  it('viewer can read a run snapshot (200)', async () => {
    const res = await request(`/${RUN}`, { method: 'GET', token: 'viewer-token' });
    expect(res.status).toBe(200);
    expect((res.json as { data: { runId: string } }).data.runId).toBe(RUN);
  });
});

describe('writer API - lifecycle + errors', () => {
  it('start uses the instruction as topic and never reaches ContentService writes', async () => {
    const startSpy = vi.mocked(WriterRunService.prototype.start);
    const updateSpy = vi.spyOn(ContentService.prototype, 'update');
    const createSpy = vi.spyOn(ContentService.prototype, 'create');
    const removeSpy = vi.spyOn(ContentService.prototype, 'remove');

    await request('', { method: 'POST', token: 'editor-token', body: { instruction: 'Write about SEO ops' } });

    expect(startSpy).toHaveBeenCalledWith(PROJECT, CONTENT, { topic: 'Write about SEO ops', targetKeyword: 'seo keyword' });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('start falls back to the content title when no instruction is given', async () => {
    const startSpy = vi.mocked(WriterRunService.prototype.start);
    await request('', { method: 'POST', token: 'editor-token', body: {} });
    expect(startSpy).toHaveBeenCalledWith(PROJECT, CONTENT, { topic: 'Existing title', targetKeyword: 'seo keyword' });
  });

  it('404 when the content does not exist in the project', async () => {
    vi.spyOn(ContentService.prototype, 'get').mockRejectedValue(ApiError.notFound('Content not found in this project') as never);
    const start = await request('', { method: 'POST', token: 'editor-token', body: { instruction: 'Write' } });
    expect(start.status).toBe(404);
    const get = await request(`/${RUN}`, { method: 'GET', token: 'viewer-token' });
    expect(get.status).toBe(404);
  });

  it('400 for a malformed runId', async () => {
    const get = await request('/not-a-run', { method: 'GET', token: 'viewer-token' });
    expect(get.status).toBe(400);
    const approve = await request('/not-a-run/approval', { method: 'POST', token: 'editor-token', body: { decision: 'approve' } });
    expect(approve.status).toBe(400);
  });

  it('400 for an invalid approval decision and extra keys', async () => {
    const bad = await request(`/${RUN}/approval`, { method: 'POST', token: 'editor-token', body: { decision: 'maybe' } });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: { code: string } }).error.code).toBe('invalid_approval_decision');

    const extra = await request(`/${RUN}/approval`, { method: 'POST', token: 'editor-token', body: { decision: 'approve', reason: 'nope' } });
    expect(extra.status).toBe(400);
  });

  it('404 for an unknown run (service fail closed)', async () => {
    vi.mocked(WriterRunService.prototype.getRun).mockRejectedValue(
      new ApiError(404, 'writer_run_not_found', 'No writer run exists for this project/content.') as never,
    );
    const res = await request(`/${RUN}`, { method: 'GET', token: 'viewer-token' });
    expect(res.status).toBe(404);
    expect((res.json as { error: { code: string } }).error.code).toBe('writer_run_not_found');
  });

  it('409 when a run is not awaiting approval', async () => {
    vi.mocked(WriterRunService.prototype.decide).mockRejectedValue(
      new ApiError(409, 'writer_run_not_awaiting_approval', 'Writer run is completed; only a run awaiting approval can be resumed.') as never,
    );
    const res = await request(`/${RUN}/approval`, { method: 'POST', token: 'editor-token', body: { decision: 'approve' } });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe('writer_run_not_awaiting_approval');
  });
});

describe('writer API - safe response envelope', () => {
  it('start response carries only the documented DTO fields (no secrets/checkpoint)', async () => {
    const res = await request('', { method: 'POST', token: 'editor-token', body: { instruction: 'Write' } });
    const json = res.json as { data: Record<string, unknown> };
    expect(Object.keys(json.data).sort()).toEqual(
      ['contentId', 'createdAt', 'note', 'plan', 'projectId', 'review', 'runId', 'status'].sort(),
    );
    const text = JSON.stringify(json).toLowerCase();
    expect(text).not.toContain('authorization');
    expect(text).not.toContain('checkpoint');
    expect(text).not.toContain('api_key');
    expect(text).not.toContain('token');
  });

  it('reject decision flows through the approval endpoint', async () => {
    vi.mocked(WriterRunService.prototype.decide).mockResolvedValue(
      dto({ status: 'rejected', note: 'Different outline needed.' }) as never,
    );
    const res = await request(`/${RUN}/approval`, { method: 'POST', token: 'editor-token', body: { decision: 'reject', reason: 'Different outline needed.' } });
    expect(res.status).toBe(200);
    expect((res.json as { data: { status: string } }).data.status).toBe('rejected');
  });
});
