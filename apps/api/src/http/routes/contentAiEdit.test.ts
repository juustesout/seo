/**
 * Cosmos AI editor endpoint (POST /content/:id/ai/edit) HTTP contract.
 *
 * The service itself is mocked so this test pins only the route boundary:
 * auth/role gating, strict zod validation of the selection/operation, and the
 * fact that a valid editor request is handed to the shared edit service with the
 * project + content ids intact.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { contentRouter } from './content.js';

const svc = vi.hoisted(() => ({
  calls: [] as Array<{ projectId: string; contentId: string; input: unknown }>,
  response: {
    operation: 'replace_selection',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tighter copy.' }] }],
    reason: 'tightened',
    model: 'openai',
  } as unknown,
}));

vi.mock('../../services/contentAiEditService.js', () => ({
  MAX_SELECTION_CHARS: 8000,
  MAX_INSTRUCTION_CHARS: 500,
  ContentAiEditService: class {
    async run(projectId: string, contentId: string, input: unknown) {
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

async function request(body: unknown, token?: string) {
  const res = await fetch(`${base}/${CONTENT}/ai/edit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } },
  };
}

const validBody = { operation: 'rewrite', selection: { from: 1, to: 10 }, text: 'Blue widgets' };

let server: Server;
let base = '';

beforeEach(() => {
  svc.calls = [];
});

describe('POST /content/:id/ai/edit', () => {
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

  it('rejects an anonymous request', async () => {
    const res = await request(validBody);
    expect(res.status).toBe(401);
    expect(svc.calls).toHaveLength(0);
  });

  it('does not let a viewer run an AI edit', async () => {
    const res = await request(validBody, 'viewer-token');
    expect(res.status).toBe(403);
    expect(svc.calls).toHaveLength(0);
  });

  it('returns the validated proposal for an editor', async () => {
    const res = await request(validBody, 'editor-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ operation: 'replace_selection', model: 'openai' });
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0]).toMatchObject({ projectId: PROJECT, contentId: CONTENT });
    expect(svc.calls[0]!.input).toMatchObject({ operation: 'rewrite', text: 'Blue widgets' });
  });

  it('rejects an unknown operation', async () => {
    const res = await request({ ...validBody, operation: 'replace_document' }, 'editor-token');
    expect(res.status).toBe(400);
    expect(svc.calls).toHaveLength(0);
  });

  it('rejects an empty selection text', async () => {
    const res = await request({ ...validBody, text: '   ' }, 'editor-token');
    expect(res.status).toBe(400);
    expect(svc.calls).toHaveLength(0);
  });

  it('rejects a reversed/empty range', async () => {
    const res = await request({ ...validBody, selection: { from: 10, to: 10 } }, 'editor-token');
    expect(res.status).toBe(400);
    expect(svc.calls).toHaveLength(0);
  });

  it('requires an instruction for Ask AI', async () => {
    const res = await request(
      { operation: 'ask', selection: { from: 1, to: 10 }, text: 'Blue widgets' },
      'editor-token',
    );
    expect(res.status).toBe(400);
    expect(svc.calls).toHaveLength(0);
  });

  it('accepts Ask AI with an instruction', async () => {
    const res = await request(
      { operation: 'ask', selection: { from: 1, to: 10 }, text: 'Blue widgets', instruction: 'Make it punchier' },
      'editor-token',
    );
    expect(res.status).toBe(200);
    expect(svc.calls).toHaveLength(1);
  });

  it('rejects an oversized selection', async () => {
    const res = await request({ ...validBody, text: 'x'.repeat(8001) }, 'editor-token');
    expect(res.status).toBe(400);
  });

  it('rejects unknown body fields (strict schema)', async () => {
    const res = await request({ ...validBody, inject: 'nope' }, 'editor-token');
    expect(res.status).toBe(400);
    expect(svc.calls).toHaveLength(0);
  });
});
