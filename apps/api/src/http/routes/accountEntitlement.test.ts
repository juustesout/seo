/**
 * Account entitlement read route (P13).
 *
 * Mounts the real `accountEntitlementRouter` over a fake container to pin the
 * account boundary: the account is taken from the authenticated session (never
 * a URL id) and the resolved model is returned under `{ data }`. Anonymous
 * requests are rejected by the router itself.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AccountEntitlementDto } from '@seo/contracts';
import { errorHandler } from '../../apiErrors.js';
import { accountEntitlementRouter } from './usage.js';

const USER = 'aa000000-0000-4000-8000-000000000001';
const ACCOUNT = 'bb000000-0000-4000-8000-000000000002';

const calls: Array<{ fn: string; actor: string; accountId: string }> = [];

const model: AccountEntitlementDto = {
  plan: { key: 'base', name: 'Base', isDefault: true },
  features: [{ feature: 'api_access', enabled: true }],
  allowances: [
    {
      resource: 'x_link_post',
      unit: 'link_posts',
      period: 'month',
      scope: 'account',
      operatorFunded: true,
      byokExempt: false,
      status: 'active',
      allowance: 0,
      consumed: 0,
      remaining: 0,
    },
  ],
  period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
};

let server: Server;
let base = '';

async function request(path: string, token?: string) {
  const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as { data?: AccountEntitlementDto; error?: { code: string } },
  };
}

describe('account entitlement route', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      (req as unknown as { container: unknown }).container = {
        access: {
          requireAccount: async (userId: string) => {
            expect(userId).toBe(USER);
            return { account_id: ACCOUNT };
          },
        },
        entitlements: {
          accountEntitlement: async (actor: string, accountId: string) => {
            calls.push({ fn: 'accountEntitlement', actor, accountId });
            return model;
          },
        },
      };
      (req as unknown as { user?: { sub: string } }).user = token === 'user-token' ? { sub: USER } : undefined;
      next();
    });
    app.use('/api/account/entitlement', accountEntitlementRouter);
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
    const res = await request('/api/account/entitlement');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('returns the caller account entitlement resolved from the session', async () => {
    const res = await request('/api/account/entitlement', 'user-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ plan: { key: 'base' }, allowances: [{ resource: 'x_link_post' }] });
    expect(calls).toEqual([{ fn: 'accountEntitlement', actor: USER, accountId: ACCOUNT }]);
  });
});
