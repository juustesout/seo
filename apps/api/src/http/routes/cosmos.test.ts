/**
 * Cosmos route tests (HTTP boundary).
 *
 * Mounts the real cosmosRouter over a fake container + Supabase-like client so
 * the wire contract is tested end to end: authentication, viewer read access,
 * editor-only writes, persistence into `settings.cosmos` without clobbering
 * sibling settings keys, project isolation and strict validation.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { cosmosRouter } from './cosmos.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'viewer-user' },
  'editor-token': { sub: 'editor-user' },
  'norole-token': { sub: 'no-role-user' },
};
const ROLE_BY_USER: Record<string, string | undefined> = { 'viewer-user': 'viewer', 'editor-user': 'editor' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

let currentStores: Store = {};

function fakeSb() {
  return {
    from(table: string) {
      const all = currentStores[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      let updatePayload: Row | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          if (updatePayload) {
            for (const row of all) if (row[col] === val) Object.assign(row, updatePayload);
            return Promise.resolve({ error: null });
          }
          filters.push((r) => r[col] === val);
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: all.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
        update: (payload: Row) => {
          updatePayload = payload;
          return builder;
        },
      };
      return builder;
    },
  };
}

function defaultStores(): Store {
  return {
    seo_projects: [
      { id: PROJECT, settings: { ai: { provider: 'openai' }, coreTopics: ['pricing'] } },
      { id: OTHER_PROJECT, settings: { cosmos: { identity: { name: 'Other Co' } } } },
    ],
  };
}

let server: Server;
let base = '';

async function request(path: string, token?: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as {
      data?: Record<string, unknown>;
      error?: { code: string; message: string };
    },
  };
}

function settingsOf(projectId: string): Row {
  return (currentStores.seo_projects!.find((p) => p.id === projectId)!.settings as Row) ?? {};
}

beforeEach(() => {
  currentStores = defaultStores();
});

describe('/api/projects/:projectId/cosmos', () => {
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
      };
      (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
      next();
    });
    app.use('/api/projects/:projectId/cosmos', cosmosRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects anonymous reads', async () => {
    const res = await request(`/${PROJECT}/cosmos`);
    expect(res.status).toBe(401);
  });

  it('rejects a non-member', async () => {
    const res = await request(`/${PROJECT}/cosmos`, 'norole-token');
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe('forbidden');
  });

  it('lets a viewer read a blank normalized config', async () => {
    const res = await request(`/${PROJECT}/cosmos`, 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({
      identity: { name: '', description: '', audience: '' },
      knowledge: { useProjectKnowledge: true },
    });
  });

  it('isolates Cosmos per project', async () => {
    const res = await request(`/${OTHER_PROJECT}/cosmos`, 'viewer-token');
    expect(res.status).toBe(200);
    expect((res.json.data as { identity: { name: string } }).identity.name).toBe('Other Co');
  });

  it('does not let a viewer write', async () => {
    const res = await request(`/${PROJECT}/cosmos`, 'viewer-token', 'PUT', { identity: { name: 'Nope' } });
    expect(res.status).toBe(403);
    expect(settingsOf(PROJECT)).not.toHaveProperty('cosmos');
  });

  it('lets an editor save and preserves sibling settings keys', async () => {
    const res = await request(`/${PROJECT}/cosmos`, 'editor-token', 'PUT', {
      identity: { name: 'Acme', audience: 'Founders' },
      voice: { tone: '  Direct  ' },
      knowledge: { useProjectKnowledge: false },
    });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({
      identity: { name: 'Acme', audience: 'Founders' },
      voice: { tone: 'Direct' },
      knowledge: { useProjectKnowledge: false },
    });
    const settings = settingsOf(PROJECT);
    expect(settings).toHaveProperty('cosmos');
    // Sibling keys survive the merge.
    expect(settings).toMatchObject({ ai: { provider: 'openai' }, coreTopics: ['pricing'] });
  });

  it('reads back what was written and drops unknown keys', async () => {
    await request(`/${PROJECT}/cosmos`, 'editor-token', 'PUT', { identity: { name: 'Acme' } });
    const res = await request(`/${PROJECT}/cosmos`, 'viewer-token');
    expect((res.json.data as { identity: { name: string } }).identity.name).toBe('Acme');
    expect(JSON.stringify(res.json.data)).not.toContain('provider');
  });

  it('rejects unknown fields with a 400 (strict schema)', async () => {
    const res = await request(`/${PROJECT}/cosmos`, 'editor-token', 'PUT', { identity: { name: 'x' }, rogue: true });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('validation_error');
  });

  it('rejects an oversized field', async () => {
    const res = await request(`/${PROJECT}/cosmos`, 'editor-token', 'PUT', { voice: { tone: 'x'.repeat(2001) } });
    expect(res.status).toBe(400);
  });
});
