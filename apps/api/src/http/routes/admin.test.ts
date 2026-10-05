/**
 * Platform admin route tests (P3, Phase C HTTP boundary).
 *
 * Mounts the real `adminRouter` over a fake container so the authorization
 * boundary is tested end to end: it is mounted by app.ts without the app-wide
 * auth middleware, so the router must 401 anonymous requests itself, must 403
 * any authenticated caller whose user id is not in the platform-admin registry
 * (a project owner/admin is not enough), and must 200 a registered
 * administrator. The gate is checked on every route, not just the first, so the
 * surface cannot be reached by bypassing a single endpoint.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import type { PlatformAdminReadService } from '../../services/platformAdminService.js';
import { adminRouter } from './admin.js';

const ADMIN_USER = 'aa000000-0000-4000-8000-000000000001';
const PROJECT_OWNER = 'bb000000-0000-4000-8000-000000000002';
const STRANGER = 'cc000000-0000-4000-8000-000000000003';
const ACCOUNT = 'dd000000-0000-4000-8000-000000000004';
const PLAN = 'ee000000-0000-4000-8000-000000000005';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'admin-token': { sub: ADMIN_USER },
  'owner-token': { sub: PROJECT_OWNER },
  'stranger-token': { sub: STRANGER },
};

// Only ADMIN_USER is registered as a platform administrator. PROJECT_OWNER is an
// ordinary account even though they may own projects.
const PLATFORM_ADMINS = new Set([ADMIN_USER]);

const calls: Array<{ fn: string; actor: string; filter?: unknown }> = [];

const fakePlatformAdmin: PlatformAdminReadService = {
  async overview(actor) {
    calls.push({ fn: 'overview', actor });
    return {
      users: 1,
      accounts: 1,
      projects: 2,
      jobs: 3,
      active_jobs: 0,
      failed_jobs: 1,
      usage_events_this_period: 5,
      usage_period_start: '2026-09-01T00:00:00Z',
      recent_jobs: [],
    };
  },
  async listUsers(actor) {
    calls.push({ fn: 'listUsers', actor });
    return [{ user_id: ADMIN_USER, email: 'a@example.com', created_at: null, account_id: ACCOUNT, project_count: 2 }];
  },
  async listAccounts(actor) {
    calls.push({ fn: 'listAccounts', actor });
    return [];
  },
  async listProjects(actor) {
    calls.push({ fn: 'listProjects', actor });
    return [];
  },
  async usage(actor, filter) {
    calls.push({ fn: 'usage', actor, filter });
    return { scope: { accountId: null, projectId: null }, totals: [] };
  },
  async listPlans(actor) {
    calls.push({ fn: 'listPlans', actor });
    return [
      {
        key: 'base',
        name: 'Base',
        description: null,
        is_default: true,
        status: 'active',
        features: ['api_access'],
        allowance_count: 5,
      },
    ];
  },
  async assignPlan(actor, accountId, planId) {
    calls.push({ fn: 'assignPlan', actor, filter: { accountId, planId } });
    return { accountId, planId };
  },
};

let server: Server;
let base = '';

async function request(path: string, token?: string) {
  const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } },
  };
}

beforeEach(() => {
  calls.length = 0;
});

describe('platform admin routes', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      (req as unknown as { container: unknown }).container = {
        access: {
          requirePlatformAdmin: async (userId: string) => {
            if (!PLATFORM_ADMINS.has(userId)) {
              throw ApiError.forbidden('Platform administrator access required');
            }
          },
        },
        platformAdmin: fakePlatformAdmin,
      };
      (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
      next();
    });
    app.use('/api/admin', adminRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects an anonymous request', async () => {
    const res = await request('/api/admin/overview');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('refuses an authenticated caller who is not a registered platform admin', async () => {
    for (const path of ['overview', 'users', 'accounts', 'projects']) {
      const res = await request(`/api/admin/${path}`, 'owner-token');
      expect(res.status).toBe(403);
    }
    const usage = await request('/api/admin/usage', 'stranger-token');
    expect(usage.status).toBe(403);
    // The service is never reached for a refused caller.
    expect(calls).toHaveLength(0);
  });

  it('allows a registered platform administrator', async () => {
    const res = await request('/api/admin/overview', 'admin-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ users: 1, projects: 2 });
    expect(calls).toEqual([{ fn: 'overview', actor: ADMIN_USER }]);
  });

  it('enforces the gate independently on every read endpoint', async () => {
    expect((await request('/api/admin/users', 'admin-token')).status).toBe(200);
    expect((await request('/api/admin/accounts', 'admin-token')).status).toBe(200);
    expect((await request('/api/admin/projects', 'admin-token')).status).toBe(200);
    expect((await request('/api/admin/usage', 'admin-token')).status).toBe(200);
    expect(calls.map((c) => c.fn)).toEqual(['listUsers', 'listAccounts', 'listProjects', 'usage']);
  });

  it('passes a validated usage filter through to the service', async () => {
    const res = await request(
      `/api/admin/usage?accountId=${ACCOUNT}&category=ai&provider=openai&operation=chat&success=true&occurredFrom=2026-09-01T00:00:00Z`,
      'admin-token',
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        fn: 'usage',
        actor: ADMIN_USER,
        filter: {
          accountId: ACCOUNT,
          category: 'ai',
          provider: 'openai',
          operation: 'chat',
          success: true,
          occurredFrom: '2026-09-01T00:00:00Z',
        },
      },
    ]);
  });

  it('rejects a malformed usage filter before calling the service', async () => {
    for (const query of ['category=nonsense', 'accountId=not-a-uuid', 'success=maybe']) {
      const res = await request(`/api/admin/usage?${query}`, 'admin-token');
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses plan management to a non-administrator', async () => {
    expect((await request('/api/admin/plans', 'owner-token')).status).toBe(403);
    const res = await fetch(`${base}/api/admin/accounts/${ACCOUNT}/plan`, {
      method: 'POST',
      headers: { authorization: 'Bearer stranger-token', 'content-type': 'application/json' },
      body: JSON.stringify({ planId: PLAN }),
    });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('lists plans for a platform administrator', async () => {
    const res = await request('/api/admin/plans', 'admin-token');
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.fn)).toEqual(['listPlans']);
  });

  it('assigns a plan and validates the request body', async () => {
    const invalid = await fetch(`${base}/api/admin/accounts/${ACCOUNT}/plan`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'not-a-uuid' }),
    });
    expect(invalid.status).toBe(400);
    expect(calls).toHaveLength(0);

    const res = await fetch(`${base}/api/admin/accounts/${ACCOUNT}/plan`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ planId: PLAN }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ fn: 'assignPlan', actor: ADMIN_USER, filter: { accountId: ACCOUNT, planId: PLAN } }]);
  });
});
