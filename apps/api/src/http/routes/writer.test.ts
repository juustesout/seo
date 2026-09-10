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
    revisionCount: 0,
    lastRevisionAt: null,
    magicAction: null,
    evidence: null,
    intelligence: null,
    agent: null,
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
  vi.spyOn(WriterRunService.prototype, 'magic').mockResolvedValue(
    dto({ status: 'revising', magicAction: 'improve' }) as never,
  );
  vi.spyOn(WriterRunService.prototype, 'research').mockResolvedValue(
    dto({ status: 'review_ready' }) as never,
  );
  vi.spyOn(WriterRunService.prototype, 'intelligence').mockResolvedValue(
    dto({ status: 'review_ready' }) as never,
  );
  vi.spyOn(WriterRunService.prototype, 'agent').mockResolvedValue(
    dto({
      status: 'review_ready',
      agent: {
        status: 'running',
        goal: 'improve_seo',
        instruction: null,
        maxSteps: 5,
        stepCount: 0,
        steps: [],
        actionCounts: { research: 0, intelligence: 0, magic: 0, revision: 0, review: 0, finish: 0 },
        note: null,
        startedAt: '2026-09-08T00:00:00.000Z',
        finishedAt: null,
      },
    }) as never,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writer API - authorization', () => {
  it.each(['POST /', 'GET /:runId', 'POST /:runId/approval', 'POST /:runId/magic', 'POST /:runId/research', 'POST /:runId/intelligence', 'POST /:runId/agent'])(
    '401 when unauthenticated',
    async (route) => {
      const [method, pathTemplate] = route.split(' ') as [string, string];
      const path =
        pathTemplate === 'POST /'
          ? ''
          : pathTemplate === '/:runId'
            ? `/${RUN}`
            : pathTemplate === '/:runId/approval'
              ? `/${RUN}/approval`
              : pathTemplate === '/:runId/magic'
                ? `/${RUN}/magic`
                : pathTemplate === '/:runId/research'
                  ? `/${RUN}/research`
                  : pathTemplate === '/:runId/intelligence'
                    ? `/${RUN}/intelligence`
                    : `/${RUN}/agent`;
      const res = await request(path, { method, body: {} });
      expect(res.status).toBe(401);
      expect((res.json as { error: { code: string } }).error.code).toBe('unauthorized');
    },
  );

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

  it('403: viewer cannot apply Section Magic', async () => {
    const res = await request(`/${RUN}/magic`, {
      method: 'POST',
      token: 'viewer-token',
      body: { action: 'improve', sectionIds: ['section_0'] },
    });
    expect(res.status).toBe(403);
  });

  it('403: viewer cannot gather research evidence', async () => {
    const res = await request(`/${RUN}/research`, { method: 'POST', token: 'viewer-token', body: {} });
    expect(res.status).toBe(403);
  });

  it('403: viewer cannot gather combined intelligence', async () => {
    const res = await request(`/${RUN}/intelligence`, {
      method: 'POST',
      token: 'viewer-token',
      body: { purpose: 'revision' },
    });
    expect(res.status).toBe(403);
  });

  it('403: viewer cannot start the advanced agent', async () => {
    const res = await request(`/${RUN}/agent`, {
      method: 'POST',
      token: 'viewer-token',
      body: { goal: 'improve_seo' },
    });
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

  it('applies a Section Magic request as an editor (200) and never touches content writes', async () => {
    const magicSpy = vi.mocked(WriterRunService.prototype.magic);
    const updateSpy = vi.spyOn(ContentService.prototype, 'update');
    const createSpy = vi.spyOn(ContentService.prototype, 'create');
    const removeSpy = vi.spyOn(ContentService.prototype, 'remove');

    const res = await request(`/${RUN}/magic`, {
      method: 'POST',
      token: 'editor-token',
      body: { action: 'shorten', sectionIds: ['section_1', 'section_0'], instruction: 'Tighten' },
    });
    expect(res.status).toBe(200);
    expect((res.json as { data: { status: string } }).data.status).toBe('revising');
    expect(magicSpy).toHaveBeenCalledWith(RUN, { action: 'shorten', sectionIds: ['section_1', 'section_0'], instruction: 'Tighten' }, PROJECT, CONTENT);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('400 for an invalid Section Magic request', async () => {
    const magicSpy = vi.mocked(WriterRunService.prototype.magic);
    const bad = await request(`/${RUN}/magic`, {
      method: 'POST',
      token: 'editor-token',
      body: { action: 'explode', sectionIds: ['section_0'] },
    });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: { code: string } }).error.code).toBe('invalid_magic_request');

    const toneMissing = await request(`/${RUN}/magic`, {
      method: 'POST',
      token: 'editor-token',
      body: { action: 'change_tone', sectionIds: ['section_0'] },
    });
    expect(toneMissing.status).toBe(400);
    expect(magicSpy).not.toHaveBeenCalled();
  });

  it('409 when a Section Magic run is not resting on review_ready', async () => {
    vi.mocked(WriterRunService.prototype.magic).mockRejectedValue(
      new ApiError(409, 'writer_run_not_review_ready', 'Writer run is writing; only a run resting on review_ready can be transformed.') as never,
    );
    const res = await request(`/${RUN}/magic`, {
      method: 'POST',
      token: 'editor-token',
      body: { action: 'improve', sectionIds: ['section_0'] },
    });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe('writer_run_not_review_ready');
  });

  it('gathers research evidence as an editor (200) with the optional purpose forwarded and never touches content writes', async () => {
    const researchSpy = vi.mocked(WriterRunService.prototype.research);
    const updateSpy = vi.spyOn(ContentService.prototype, 'update');
    const createSpy = vi.spyOn(ContentService.prototype, 'create');
    const removeSpy = vi.spyOn(ContentService.prototype, 'remove');

    const planned = await request(`/${RUN}/research`, {
      method: 'POST',
      token: 'editor-token',
      body: { purpose: 'planning' },
    });
    expect(planned.status).toBe(200);
    expect((planned.json as { data: { status: string } }).data.status).toBe('review_ready');
    expect(researchSpy).toHaveBeenCalledWith(RUN, 'planning', PROJECT, CONTENT);

    // No purpose defaults to the bounded revision vocabulary.
    const defaulted = await request(`/${RUN}/research`, { method: 'POST', token: 'editor-token', body: {} });
    expect(defaulted.status).toBe(200);
    expect(researchSpy).toHaveBeenCalledWith(RUN, 'revision', PROJECT, CONTENT);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('400 for an invalid research purpose and never reaches the service', async () => {
    const researchSpy = vi.mocked(WriterRunService.prototype.research);
    const bad = await request(`/${RUN}/research`, {
      method: 'POST',
      token: 'editor-token',
      body: { purpose: 'scrape_the_internet' },
    });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: { code: string } }).error.code).toBe('invalid_research_request');
    expect(researchSpy).not.toHaveBeenCalled();
  });

  it('409 when research runs on a run not resting on review_ready', async () => {
    vi.mocked(WriterRunService.prototype.research).mockRejectedValue(
      new ApiError(409, 'writer_run_not_review_ready', 'Writer run is writing; only a run resting on review_ready can gather evidence.') as never,
    );
    const res = await request(`/${RUN}/research`, { method: 'POST', token: 'editor-token', body: {} });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe('writer_run_not_review_ready');
  });

  it('gathers combined intelligence as an editor (200) forwarding the bounded request and never touching content writes', async () => {
    const intelligenceSpy = vi.mocked(WriterRunService.prototype.intelligence);
    const updateSpy = vi.spyOn(ContentService.prototype, 'update');
    const createSpy = vi.spyOn(ContentService.prototype, 'create');
    const removeSpy = vi.spyOn(ContentService.prototype, 'remove');

    const res = await request(`/${RUN}/intelligence`, {
      method: 'POST',
      token: 'editor-token',
      body: { purpose: 'deep_research', focus: 'keyword gaps', sections: ['section_0'] },
    });
    expect(res.status).toBe(200);
    expect((res.json as { data: { status: string } }).data.status).toBe('review_ready');
    expect(intelligenceSpy).toHaveBeenCalledWith(
      RUN,
      { purpose: 'deep_research', focus: 'keyword gaps', sections: ['section_0'] },
      PROJECT,
      CONTENT,
    );

    const defaulted = await request(`/${RUN}/intelligence`, {
      method: 'POST',
      token: 'editor-token',
      body: { purpose: 'planning' },
    });
    expect(defaulted.status).toBe(200);
    expect(intelligenceSpy).toHaveBeenCalledWith(
      RUN,
      { purpose: 'planning', focus: null, sections: [] },
      PROJECT,
      CONTENT,
    );

    expect(updateSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('400 for an invalid intelligence request and never reaches the service', async () => {
    const intelligenceSpy = vi.mocked(WriterRunService.prototype.intelligence);
    const bad = await request(`/${RUN}/intelligence`, {
      method: 'POST',
      token: 'editor-token',
      body: { purpose: 'browse_the_web' },
    });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: { code: string } }).error.code).toBe('invalid_intelligence_request');
    expect(intelligenceSpy).not.toHaveBeenCalled();

    const workflowControl = await request(`/${RUN}/intelligence`, {
      method: 'POST',
      token: 'editor-token',
      body: { purpose: 'revision', approve: true },
    });
    expect(workflowControl.status).toBe(400);
    expect(intelligenceSpy).not.toHaveBeenCalled();
  });

  it('409 when intelligence runs on a run not resting on review_ready', async () => {
    vi.mocked(WriterRunService.prototype.intelligence).mockRejectedValue(
      new ApiError(409, 'writer_run_not_review_ready', 'Writer run is writing; only a run resting on review_ready can gather intelligence.') as never,
    );
    const res = await request(`/${RUN}/intelligence`, {
      method: 'POST',
      token: 'editor-token',
      body: { purpose: 'revision' },
    });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe('writer_run_not_review_ready');
  });
});

describe('writer API - advanced agent (W10.4)', () => {
  it('starts a bounded agent as an editor (200), forwards the parsed request and never touches content writes', async () => {
    const agentSpy = vi.mocked(WriterRunService.prototype.agent);
    const updateSpy = vi.spyOn(ContentService.prototype, 'update');

    const res = await request(`/${RUN}/agent`, {
      method: 'POST',
      token: 'editor-token',
      body: { goal: 'improve_seo', max_steps: 3, instruction: 'tighten the intro', sections: ['section_0'] },
    });

    expect(res.status).toBe(200);
    expect(agentSpy).toHaveBeenCalledWith(
      RUN,
      { goal: 'improve_seo', maxSteps: 3, instruction: 'tighten the intro', sections: ['section_0'] },
      PROJECT,
      CONTENT,
    );
    expect(updateSpy).not.toHaveBeenCalled();
    const data = (res.json as { data: { status: string; agent: { status: string } | null } }).data;
    expect(data.status).toBe('review_ready');
    expect(data.agent?.status).toBe('running');
  });

  it('400 for an invalid agent request (unknown goal / extra workflow fields) and never reaches the service', async () => {
    const agentSpy = vi.mocked(WriterRunService.prototype.agent);
    const bad = await request(`/${RUN}/agent`, { method: 'POST', token: 'editor-token', body: { goal: 'do_everything' } });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: { code: string } }).error.code).toBe('invalid_agent_request');
    expect(agentSpy).not.toHaveBeenCalled();

    const extra = await request(`/${RUN}/agent`, {
      method: 'POST',
      token: 'editor-token',
      body: { goal: 'improve_seo', auto_apply: true },
    });
    expect(extra.status).toBe(400);
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it('409 when the agent starts on a run not resting on review_ready', async () => {
    vi.mocked(WriterRunService.prototype.agent).mockRejectedValue(
      new ApiError(409, 'writer_run_not_review_ready', 'Writer run is writing; only a run resting on review_ready can start the agent.') as never,
    );
    const res = await request(`/${RUN}/agent`, { method: 'POST', token: 'editor-token', body: { goal: 'improve_seo' } });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe('writer_run_not_review_ready');
  });

  it('409 when an agent run is already in progress (busy)', async () => {
    vi.mocked(WriterRunService.prototype.agent).mockRejectedValue(
      new ApiError(409, 'writer_agent_busy', 'Writer run already has an agent run in progress.') as never,
    );
    const res = await request(`/${RUN}/agent`, { method: 'POST', token: 'editor-token', body: { goal: 'improve_seo' } });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe('writer_agent_busy');
  });

  it('agent response carries only the safe progress DTO (no prompts/reasoning/credentials)', async () => {
    const res = await request(`/${RUN}/agent`, { method: 'POST', token: 'editor-token', body: { goal: 'improve_seo' } });
    expect(res.status).toBe(200);
    const agent = (res.json as { data: { agent: Record<string, unknown> } }).data.agent;
    expect(Object.keys(agent).sort()).toEqual(
      [
        'actionCounts',
        'finishedAt',
        'goal',
        'instruction',
        'maxSteps',
        'note',
        'startedAt',
        'status',
        'stepCount',
        'steps',
      ].sort(),
    );
    const text = JSON.stringify(res.json).toLowerCase();
    expect(text).not.toContain('prompt');
    expect(text).not.toContain('reasoning');
    expect(text).not.toContain('api_key');
  });
});

describe('writer API - safe response envelope', () => {
  it('start response carries only the documented DTO fields (no secrets/checkpoint)', async () => {
    const res = await request('', { method: 'POST', token: 'editor-token', body: { instruction: 'Write' } });
    const json = res.json as { data: Record<string, unknown> };
    expect(Object.keys(json.data).sort()).toEqual(
      ['agent', 'contentId', 'createdAt', 'evidence', 'intelligence', 'lastRevisionAt', 'magicAction', 'note', 'plan', 'projectId', 'review', 'revisionCount', 'runId', 'status'].sort(),
    );
    const text = JSON.stringify(json).toLowerCase();
    expect(text).not.toContain('authorization');
    expect(text).not.toContain('checkpoint');
    expect(text).not.toContain('api_key');
    expect(text).not.toContain('token');
  });

  it('intelligence response carries only the safe untrusted DTO (no raw provider payloads)', async () => {
    vi.mocked(WriterRunService.prototype.intelligence).mockResolvedValue(
      dto({
        status: 'review_ready',
        intelligence: {
          gatheredAt: '2026-09-08T00:00:00.000Z',
          status: 'partial',
          findings: [
            { id: 'keyword:0', type: 'keyword', summary: 'langgraph volume:1200', evidenceIds: ['langgraph'], trust: 'untrusted' },
          ],
          sources: [
            { source: 'dataforseo', status: 'available', note: null, findingCount: 1 },
            { source: 'gsc', status: 'not_configured', note: 'not wired', findingCount: 0 },
          ],
          note: 'Intelligence gathered from some sources.',
        },
      }) as never,
    );
    const res = await request(`/${RUN}/intelligence`, {
      method: 'POST',
      token: 'editor-token',
      body: { purpose: 'deep_research' },
    });
    expect(res.status).toBe(200);
    const data = (res.json as { data: { intelligence: { findings: Array<{ trust: string }>; status: string } } }).data;
    expect(data.intelligence.status).toBe('partial');
    expect(data.intelligence.findings[0].trust).toBe('untrusted');
    const text = JSON.stringify(res.json).toLowerCase();
    expect(text).not.toContain('api_key');
    expect(text).not.toContain('provider_response');
    expect(text).not.toContain('checkpoint');
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
