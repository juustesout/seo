/**
 * Usage read route tests (R5.10.8 HTTP boundary).
 *
 * Mounts the real usage routers over a fake container backed by the real
 * in-memory ledger store, so the wire contract is tested end to end:
 * authentication, project role gate, account scoping, the aggregate-only
 * response shape, filter pass-through, empty state and bounded/invalid query
 * rejection. The read must never expose raw events or cross a scope boundary.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import { accountUsageRouter, usageRouter } from './usage.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '44444444-4444-4444-8444-444444444444';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: USER },
  'norole-token': { sub: OTHER_USER },
  'account-token': { sub: USER },
};
const ROLE_BY_USER: Record<string, string | undefined> = { [USER]: 'viewer' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

let store: InMemoryUsageEventStore;

function event(over: Record<string, unknown> = {}) {
  return {
    accountId: null,
    projectId: PROJECT,
    userId: USER,
    category: 'ai' as const,
    provider: 'openai',
    operation: 'chat',
    quantity: 10,
    unit: 'input_token' as const,
    success: true,
    sourceId: null,
    ...over,
  };
}

let server: Server;
let base = '';

async function request(path: string, token?: string) {
  const res = await fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as {
      data?: unknown;
      error?: { code: string; message: string };
    },
  };
}

const totalsOf = (json: { data?: unknown }) => (json.data as { totals: unknown[] }).totals;

beforeEach(() => {
  store = new InMemoryUsageEventStore();
});

describe('usage read routes', () => {
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
          requireAccount: async (userId: string) => {
            if (userId !== USER) throw ApiError.forbidden('No account for this user');
            return { account_id: ACCOUNT };
          },
        },
        usageEvents: {
          aggregate: (arg: Parameters<InMemoryUsageEventStore['aggregate']>[0]) => store.aggregate(arg),
          append: (events: Parameters<InMemoryUsageEventStore['append']>[0]) => store.append(events),
          list: (filter: Parameters<InMemoryUsageEventStore['list']>[0]) => store.list(filter),
        },
      };
      (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
      next();
    });
    app.use('/api/projects/:projectId/usage', usageRouter);
    app.use('/api/account/usage', accountUsageRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects an anonymous project read', async () => {
    const res = await request(`/api/projects/${PROJECT}/usage`);
    expect(res.status).toBe(401);
  });

  it('rejects a user with no project role', async () => {
    const res = await request(`/api/projects/${PROJECT}/usage`, 'norole-token');
    expect(res.status).toBe(403);
  });

  it('returns an empty report when the ledger is empty', async () => {
    const res = await request(`/api/projects/${PROJECT}/usage`, 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ scope: { accountId: null, projectId: PROJECT }, totals: [] });
  });

  it('aggregates by category/provider/operation/unit with an event count', async () => {
    await store.append([
      event({ quantity: 10 }),
      event({ quantity: 5 }),
      event({ category: 'media', provider: 'unsplash', operation: 'media_search', unit: 'request', quantity: 1 }),
    ]);
    const res = await request(`/api/projects/${PROJECT}/usage`, 'viewer-token');
    expect(res.status).toBe(200);
    expect(totalsOf(res.json)).toEqual([
      { category: 'ai', provider: 'openai', operation: 'chat', unit: 'input_token', quantity: 15, eventCount: 2 },
      { category: 'media', provider: 'unsplash', operation: 'media_search', unit: 'request', quantity: 1, eventCount: 1 },
    ]);
  });

  it('does not return another project usage', async () => {
    await store.append([event({ projectId: OTHER_PROJECT })]);
    const res = await request(`/api/projects/${PROJECT}/usage`, 'viewer-token');
    expect(res.status).toBe(200);
    expect(totalsOf(res.json)).toEqual([]);
  });

  it('filters by category, provider, operation, unit and success', async () => {
    await store.append([
      event({ category: 'ai', provider: 'openai', operation: 'chat', unit: 'input_token', success: true, quantity: 10 }),
      event({ category: 'ai', provider: 'openai', operation: 'embed', unit: 'input_token', success: true, quantity: 3 }),
      event({ category: 'dataforseo', provider: 'dataforseo', operation: 'serp_live', unit: 'serp_request', success: false, quantity: 1 }),
    ]);
    const res = await request(
      `/api/projects/${PROJECT}/usage?category=ai&provider=openai&operation=chat&unit=input_token&success=true`,
      'viewer-token',
    );
    expect(res.status).toBe(200);
    expect(totalsOf(res.json)).toEqual([
      { category: 'ai', provider: 'openai', operation: 'chat', unit: 'input_token', quantity: 10, eventCount: 1 },
    ]);
  });

  it('filters by an occurred window (from inclusive, to exclusive)', async () => {
    await store.append([
      event({ occurredAt: '2026-01-01T00:00:00.000Z', quantity: 1 }),
      event({ occurredAt: '2026-02-01T00:00:00.000Z', quantity: 2 }),
      event({ occurredAt: '2026-03-01T00:00:00.000Z', quantity: 4 }),
    ]);
    const res = await request(
      `/api/projects/${PROJECT}/usage?occurredFrom=2026-02-01T00:00:00.000Z&occurredTo=2026-03-01T00:00:00.000Z`,
      'viewer-token',
    );
    expect(res.status).toBe(200);
    expect(totalsOf(res.json)).toEqual([
      { category: 'ai', provider: 'openai', operation: 'chat', unit: 'input_token', quantity: 2, eventCount: 1 },
    ]);
  });

  it('rejects an unknown category, unit and provider token at the edge', async () => {
    for (const query of ['category=nonsense', 'unit=nonsense', 'provider=BAD TOKEN']) {
      const res = await request(`/api/projects/${PROJECT}/usage?${query}`, 'viewer-token');
      expect(res.status).toBe(400);
    }
  });

  it('rejects a malformed occurred window at the edge', async () => {
    const res = await request(`/api/projects/${PROJECT}/usage?occurredFrom=not-a-date`, 'viewer-token');
    expect(res.status).toBe(400);
  });

  it('reads the caller account scope only', async () => {
    await store.append([
      event({ projectId: null, accountId: ACCOUNT, quantity: 7 }),
      event({ projectId: PROJECT, accountId: null, quantity: 99 }),
    ]);
    const res = await request('/api/account/usage', 'account-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({
      scope: { accountId: ACCOUNT, projectId: null },
      totals: [{ category: 'ai', provider: 'openai', operation: 'chat', unit: 'input_token', quantity: 7, eventCount: 1 }],
    });
  });

  it('rejects an anonymous account read', async () => {
    const res = await request('/api/account/usage');
    expect(res.status).toBe(401);
  });
});
