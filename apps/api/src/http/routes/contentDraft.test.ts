/**
 * Article-scoped Agent Controls endpoint (POST /content/:id/draft). The route
 * must be editor-only, validate mode/format through the shared registries, and
 * hand off to the service which always creates a NEW draft (contentId: null).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import type { EnqueueJobInput } from '../../jobs/types.js';
import { contentRouter } from './content.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CONTENT = '22222222-2222-4222-8222-222222222222';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'viewer-user' },
  'editor-token': { sub: 'editor-user' },
};
const ROLE_BY_USER: Record<string, string | undefined> = { 'viewer-user': 'viewer', 'editor-user': 'editor' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

type Row = Record<string, unknown>;

let enqueued: EnqueueJobInput[] = [];
let writes: string[] = [];

function articleRow(): Row {
  return {
    id: CONTENT,
    project_id: PROJECT,
    title: 'Blue widgets',
    excerpt: 'Widgets for careful buyers',
    target_keyword: 'blue widgets',
    language: 'en',
  };
}

function fakeSb() {
  const rows = [articleRow()];
  function builder() {
    const filters: Array<(row: Row) => boolean> = [];
    const b = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters.push((row) => row[col] === val);
        return b;
      },
      maybeSingle: async () => ({ data: rows.filter((row) => filters.every((f) => f(row)))[0] ?? null, error: null }),
      insert: () => {
        writes.push('insert');
        return b;
      },
      update: () => {
        writes.push('update');
        return b;
      },
    };
    return b;
  }
  return { from: () => builder() };
}

async function request(path: string, opts: { token?: string; method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } },
  };
}

let server: Server;
let base = '';

beforeEach(() => {
  enqueued = [];
  writes = [];
});

describe('article draft route', () => {
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
        sb: fakeSb(),
        jobStore: {
          list: async () => [],
          enqueue: async (input: EnqueueJobInput) => {
            enqueued.push(input);
            return { id: 'job-1', status: 'queued', ...input };
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
    const res = await request(`/${CONTENT}/draft`, { method: 'POST', body: {} });
    expect(res.status).toBe(401);
    expect(enqueued).toHaveLength(0);
  });

  it('blocks a viewer from starting a draft', async () => {
    const res = await request(`/${CONTENT}/draft`, { token: 'viewer-token', method: 'POST', body: {} });
    expect(res.status).toBe(403);
    expect(enqueued).toHaveLength(0);
  });

  it('defaults to quick_draft + short_article and always creates a new draft', async () => {
    const res = await request(`/${CONTENT}/draft`, { token: 'editor-token', method: 'POST', body: {} });
    expect(res.status).toBe(202);
    expect(enqueued).toHaveLength(1);
    const params = enqueued[0]!.params as Record<string, unknown>;
    expect(params.source_content_id).toBe(CONTENT);
    const writerInput = params.writer_input as Record<string, unknown>;
    expect(writerInput.contentId).toBe(null);
    expect(writerInput.mode).toBe('quick_draft');
    expect(writerInput.format).toBe('short_article');
    expect(writes).toEqual([]);
  });

  it('accepts explicit deep_write + explainer', async () => {
    const res = await request(`/${CONTENT}/draft`, {
      token: 'editor-token',
      method: 'POST',
      body: { mode: 'deep_write', format: 'explainer' },
    });
    expect(res.status).toBe(202);
    const writerInput = enqueued[0]!.params?.writer_input as Record<string, unknown>;
    expect(writerInput.mode).toBe('deep_write');
    expect(writerInput.format).toBe('explainer');
  });

  it('rejects an invalid mode', async () => {
    const res = await request(`/${CONTENT}/draft`, {
      token: 'editor-token',
      method: 'POST',
      body: { mode: 'turbo' },
    });
    expect(res.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  it('rejects an invalid format', async () => {
    const res = await request(`/${CONTENT}/draft`, {
      token: 'editor-token',
      method: 'POST',
      body: { format: 'novel' },
    });
    expect(res.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });
});
