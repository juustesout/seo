/**
 * Designer intent route tests (HTTP boundary, Stage 8E.6 Phase 3.3).
 *
 * Mounts the real designerRouter over a fake container with DesignerService and
 * ContentService mocked, so the wire contract is tested on its own:
 * authentication, editor-only access, strict bounded body validation (including
 * the content_id/base_revision superRefine), project-scoped content preflight,
 * lossless delegation into executeIntent with the LLM planner, the
 * `{ data: { proposal } }` envelope, typed error passthrough and the fact that
 * the route is proposal-only (never apply/execute/persist).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { designerRouter } from './designer.js';

const svc = vi.hoisted(() => ({
  instances: [] as Array<{ options: unknown }>,
  intentCalls: [] as Array<{ projectId: string; intent: unknown; options: unknown }>,
  executeCalls: [] as unknown[],
  applyCalls: [] as unknown[],
  proposal: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] } } as unknown,
  error: null as unknown,
}));

vi.mock('../../services/designerService.js', () => ({
  DesignerService: class {
    constructor(_container: unknown, options: unknown) {
      svc.instances.push({ options });
    }
    async executeIntent(projectId: string, intent: unknown, options: unknown) {
      svc.intentCalls.push({ projectId, intent, options });
      if (svc.error) throw svc.error;
      return svc.proposal;
    }
    async execute(...args: unknown[]) {
      svc.executeCalls.push(args);
      return svc.proposal;
    }
    async apply(...args: unknown[]) {
      svc.applyCalls.push(args);
      return { id: 'c1' };
    }
  },
}));

const content = vi.hoisted(() => ({
  gets: [] as Array<{ projectId: string; id: string }>,
  error: null as unknown,
}));

vi.mock('../../services/contentService.js', () => ({
  ContentService: class {
    async get(projectId: string, id: string) {
      content.gets.push({ projectId, id });
      if (content.error) throw content.error;
      return { id };
    }
  },
}));

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CONTENT = '33333333-3333-4333-8333-333333333333';
const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'viewer-user' },
  'editor-token': { sub: 'editor-user' },
  'norole-token': { sub: 'no-role-user' },
};
const ROLE_BY_USER: Record<string, string | undefined> = { 'viewer-user': 'viewer', 'editor-user': 'editor' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

let server: Server;
let base = '';

async function post(path: string, token: string | undefined, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as {
      data?: unknown;
      error?: { code: string; message: string };
    },
  };
}

beforeEach(() => {
  svc.instances = [];
  svc.intentCalls = [];
  svc.executeCalls = [];
  svc.applyCalls = [];
  svc.error = null;
  content.gets = [];
  content.error = null;
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    (req as unknown as { container: unknown }).container = {
      sb: {},
      access: {
        requireRole: async (userId: string, _projectId: string, minRole: string) => {
          const role = ROLE_BY_USER[userId];
          if (!role) throw ApiError.forbidden('You do not have access to this project');
          if ((ROLE_ORDER[role] ?? -1) < ROLE_ORDER[minRole]) {
            throw ApiError.forbidden(`This action requires the ${minRole} role`);
          }
        },
      },
    };
    (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
    next();
  });
  app.use('/api/projects/:projectId/designer', designerRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const EDIT = { instruction: 'Maak de introductie korter.', content_id: CONTENT };
const CREATE = { instruction: 'Maak een artikel over SEO.', base_revision: 'client-rev-1' };

describe('/api/projects/:projectId/designer/intent authorization', () => {
  it('rejects anonymous requests', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, undefined, EDIT);
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe('unauthorized');
  });

  it('rejects a non-member', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'norole-token', EDIT);
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe('forbidden');
    expect(svc.intentCalls).toHaveLength(0);
  });

  it('rejects a viewer (editor+ required)', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'viewer-token', EDIT);
    expect(res.status).toBe(403);
    expect(svc.intentCalls).toHaveLength(0);
  });

  it('accepts an editor', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', EDIT);
    expect(res.status).toBe(200);
  });
});

describe('/api/projects/:projectId/designer/intent validation', () => {
  it('rejects a malformed project id before any service call', async () => {
    const res = await post('/not-a-uuid/designer/intent', 'editor-token', EDIT);
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('bad_request');
    expect(svc.intentCalls).toHaveLength(0);
  });

  it('rejects a missing instruction', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', { content_id: CONTENT });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
  });

  it('rejects a blank instruction', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', { instruction: '   ', content_id: CONTENT });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
  });

  it('rejects an instruction over the maximum', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', {
      instruction: 'x'.repeat(2001),
      content_id: CONTENT,
    });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
  });

  it('rejects an unknown body field', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', { ...EDIT, color: 'red' });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
  });

  it('rejects a spoofed body projectId', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', {
      ...CREATE,
      projectId: '22222222-2222-4222-8222-222222222222',
    });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
  });

  it('rejects an invalid content_id', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', {
      instruction: 'Edit it',
      content_id: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
  });

  it('rejects an invalid base_revision', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', {
      instruction: 'Create it',
      base_revision: '',
    });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
  });

  it('rejects an invalid brief', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', {
      instruction: 'Create it',
      base_revision: 'client-rev-1',
      brief: { format: 'article' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
  });

  it('rejects content_id and base_revision together', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', {
      instruction: 'Edit it',
      content_id: CONTENT,
      base_revision: 'client-rev-1',
    });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
    expect(content.gets).toHaveLength(0);
    expect(svc.intentCalls).toHaveLength(0);
  });

  it('rejects neither content_id nor base_revision', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', { instruction: 'Do something' });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
    expect(svc.intentCalls).toHaveLength(0);
  });
});

describe('/api/projects/:projectId/designer/intent content scoping', () => {
  it('preflights content_id through the project-scoped ContentService', async () => {
    await post(`/${PROJECT}/designer/intent`, 'editor-token', EDIT);
    expect(content.gets).toEqual([{ projectId: PROJECT, id: CONTENT }]);
  });

  it('rejects foreign/unknown content with 404 and never calls the service', async () => {
    content.error = ApiError.notFound('Content not found in this project');
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', EDIT);
    expect(res.status).toBe(404);
    expect(res.json.error?.code).toBe('not_found');
    expect(svc.instances).toHaveLength(0);
    expect(svc.intentCalls).toHaveLength(0);
  });

  it('does not preflight a creation intent', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', CREATE);
    expect(res.status).toBe(200);
    expect(content.gets).toHaveLength(0);
  });
});

describe('/api/projects/:projectId/designer/intent delegation', () => {
  it('forwards URL projectId, instruction, contentId and options without loss', async () => {
    await post(`/${PROJECT}/designer/intent`, 'editor-token', EDIT);
    expect(svc.intentCalls).toEqual([
      {
        projectId: PROJECT,
        intent: { instruction: EDIT.instruction, projectId: PROJECT, contentId: CONTENT },
        options: {},
      },
    ]);
  });

  it('forwards a brief and a creation baseRevision', async () => {
    const brief = { goal: 'Write a clear article' };
    await post(`/${PROJECT}/designer/intent`, 'editor-token', { ...CREATE, brief });
    expect(svc.intentCalls).toEqual([
      {
        projectId: PROJECT,
        intent: { instruction: CREATE.instruction, projectId: PROJECT, brief },
        options: { baseRevision: 'client-rev-1' },
      },
    ]);
  });

  it('always constructs the service with the LLM planner', async () => {
    await post(`/${PROJECT}/designer/intent`, 'editor-token', EDIT);
    expect(svc.instances).toEqual([{ options: { llmPlanner: true } }]);
  });
});

describe('/api/projects/:projectId/designer/intent success', () => {
  it('returns exactly { data: { proposal } } for an existing-content edit', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', EDIT);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: { proposal: svc.proposal } });
  });

  it('returns a proposal for a creation intent with base_revision', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', CREATE);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: { proposal: svc.proposal } });
  });
});

describe('/api/projects/:projectId/designer/intent error passthrough', () => {
  it('maps an unconfigured planner to 503 designer_planner_not_configured', async () => {
    svc.error = new ApiError(503, 'designer_planner_not_configured', 'No AI provider');
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', EDIT);
    expect(res.status).toBe(503);
    expect(res.json.error?.code).toBe('designer_planner_not_configured');
  });

  it('maps a planner/provider failure to 502 designer_planner_failed', async () => {
    svc.error = new ApiError(502, 'designer_planner_failed', 'upstream failed');
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', EDIT);
    expect(res.status).toBe(502);
    expect(res.json.error?.code).toBe('designer_planner_failed');
  });

  it('maps invalid planner output to 422 designer_planner_invalid_output', async () => {
    svc.error = new ApiError(422, 'designer_planner_invalid_output', 'bad plan');
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', EDIT);
    expect(res.status).toBe(422);
    expect(res.json.error?.code).toBe('designer_planner_invalid_output');
  });

  it('maps an unexpected failure to the safe 500 internal_error', async () => {
    svc.error = new Error('boom with internals');
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', EDIT);
    expect(res.status).toBe(500);
    expect(res.json.error?.code).toBe('internal_error');
    expect(res.json.error?.message).not.toContain('internals');
  });
});

describe('/api/projects/:projectId/designer/intent is proposal-only', () => {
  it('never executes, applies or persists on success', async () => {
    const res = await post(`/${PROJECT}/designer/intent`, 'editor-token', EDIT);
    expect(res.status).toBe(200);
    expect(svc.intentCalls).toHaveLength(1);
    expect(svc.executeCalls).toHaveLength(0);
    expect(svc.applyCalls).toHaveLength(0);
    expect(content.gets).toEqual([{ projectId: PROJECT, id: CONTENT }]);
  });
});
