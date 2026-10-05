/**
 * Content intelligence endpoint (GET /content/:id/intelligence) role gate.
 *
 * P11 closes the viewer-triggered AI gap: the deterministic report stays
 * viewer-readable, but the optional server-funded AI pass (`?with_ai=1`)
 * requires editor rights. The service is mocked so this pins only the boundary.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { contentRouter } from './content.js';

const svc = vi.hoisted(() => ({
  calls: [] as Array<{ projectId: string; contentId: string; input: unknown }>,
  response: { signals: [], assistant: null } as unknown,
}));

vi.mock('../../services/contentIntelligenceService.js', () => ({
  ContentIntelligenceService: class {
    async report(projectId: string, contentId: string, input: unknown) {
      svc.calls.push({ projectId, contentId, input });
      return svc.response;
    }
  },
}));

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CONTENT = '22222222-2222-4222-8222-222222222222';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'viewer-user' },
  'editor-token': { sub: 'editor-user' },
};
const ROLE_BY_USER: Record<string, string | undefined> = { 'viewer-user': 'viewer', 'editor-user': 'editor' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

async function request(query: string, token?: string) {
  const res = await fetch(`${base}/${CONTENT}/intelligence${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } },
  };
}

let server: Server;
let base = '';

beforeEach(() => {
  svc.calls = [];
});

describe('GET /content/:id/intelligence', () => {
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
            if ((ROLE_ORDER[role] ?? -1) < (ROLE_ORDER[minRole] ?? -1)) {
              throw ApiError.forbidden(`This action requires the ${minRole} role`);
            }
          },
        },
      };
      (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
      next();
    });
    app.use('/api/projects/:projectId/content', contentRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${PROJECT}/content`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('lets a viewer read the deterministic report without the AI pass', async () => {
    const res = await request('', 'viewer-token');
    expect(res.status).toBe(200);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0]!.input).toMatchObject({ withAi: false, actorUserId: 'viewer-user' });
  });

  it('denies a viewer the server-funded AI pass', async () => {
    const res = await request('?with_ai=1', 'viewer-token');
    expect(res.status).toBe(403);
    expect(svc.calls).toHaveLength(0);
  });

  it('lets an editor run the server-funded AI pass', async () => {
    const res = await request('?with_ai=1', 'editor-token');
    expect(res.status).toBe(200);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0]!.input).toMatchObject({ withAi: true, actorUserId: 'editor-user' });
  });
});
