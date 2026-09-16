/**
 * Composition planning route tests (HTTP boundary).
 *
 * Mounts the real compositionRouter over a fake container with the planner
 * service mocked, so the wire contract is tested on its own: authentication,
 * editor-only access, strict body validation, the `{ data }` envelope and the
 * mapping of typed planner failures onto HTTP status codes. The plan is never
 * persisted (the service has no write path).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { MARKETING_STORYBOARD_PLAN } from '@seo/contracts';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { compositionRouter } from './composition.js';

const mock = vi.hoisted(() => ({ plan: vi.fn() }));

vi.mock('../../services/compositionPlannerService.js', () => ({
  CompositionPlannerService: class {
    plan(projectId: string, input: unknown) {
      return mock.plan(projectId, input);
    }
  },
}));

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'viewer-user' },
  'editor-token': { sub: 'editor-user' },
  'norole-token': { sub: 'no-role-user' },
};
const ROLE_BY_USER: Record<string, string | undefined> = { 'viewer-user': 'viewer', 'editor-user': 'editor' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

let server: Server;
let base = '';

async function request(path: string, token: string | undefined, body?: unknown) {
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

const brief = 'Launch a landing page for our analytics tool.';

beforeEach(() => {
  mock.plan.mockReset();
  mock.plan.mockResolvedValue(MARKETING_STORYBOARD_PLAN);
});

describe('/api/projects/:projectId/composition/plan', () => {
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
      };
      (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
      next();
    });
    app.use('/api/projects/:projectId/composition', compositionRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects anonymous requests', async () => {
    const res = await request(`/${PROJECT}/composition/plan`, undefined, { brief });
    expect(res.status).toBe(401);
  });

  it('rejects a non-member', async () => {
    const res = await request(`/${PROJECT}/composition/plan`, 'norole-token', { brief });
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe('forbidden');
  });

  it('rejects a viewer (editor+ required)', async () => {
    const res = await request(`/${PROJECT}/composition/plan`, 'viewer-token', { brief });
    expect(res.status).toBe(403);
    expect(mock.plan).not.toHaveBeenCalled();
  });

  it('rejects a malformed project id', async () => {
    const res = await request('/not-a-uuid/composition/plan', 'editor-token', { brief });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('bad_request');
  });

  it('rejects a too-short brief', async () => {
    const res = await request(`/${PROJECT}/composition/plan`, 'editor-token', { brief: 'x' });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
  });

  it('rejects unknown body keys', async () => {
    const res = await request(`/${PROJECT}/composition/plan`, 'editor-token', { brief, style: 'red' });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
  });

  it('rejects an unsupported format', async () => {
    const res = await request(`/${PROJECT}/composition/plan`, 'editor-token', { brief, format: 'email' });
    expect(res.status).toBe(400);
  });

  it('returns the plan for an editor', async () => {
    const res = await request(`/${PROJECT}/composition/plan`, 'editor-token', { brief });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual(MARKETING_STORYBOARD_PLAN);
    expect(mock.plan).toHaveBeenCalledWith(PROJECT, { brief });
  });

  it('passes an explicit format through', async () => {
    await request(`/${PROJECT}/composition/plan`, 'editor-token', { brief, format: 'article' });
    expect(mock.plan).toHaveBeenCalledWith(PROJECT, { brief, format: 'article' });
  });

  it('maps not_configured to 503', async () => {
    mock.plan.mockRejectedValue(ApiError.notConfigured('no key'));
    const res = await request(`/${PROJECT}/composition/plan`, 'editor-token', { brief });
    expect(res.status).toBe(503);
    expect(res.json.error?.code).toBe('not_configured');
  });

  it('maps ai_error to 502', async () => {
    mock.plan.mockRejectedValue(new ApiError(502, 'ai_error', 'upstream failed'));
    const res = await request(`/${PROJECT}/composition/plan`, 'editor-token', { brief });
    expect(res.status).toBe(502);
    expect(res.json.error?.code).toBe('ai_error');
  });

  it('maps invalid_output to 422', async () => {
    mock.plan.mockRejectedValue(new ApiError(422, 'invalid_output', 'bad plan'));
    const res = await request(`/${PROJECT}/composition/plan`, 'editor-token', { brief });
    expect(res.status).toBe(422);
    expect(res.json.error?.code).toBe('invalid_output');
  });
});
