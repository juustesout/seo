/**
 * Customer plan catalog route (P15).
 *
 * Mounts the real `plansRouter` over a fake container to pin the catalog
 * contract: any authenticated user may read the product catalog (it carries no
 * account state), anonymous requests are rejected, and the DTO is returned
 * under `{ data }`. The route is presentation only - it never resolves account
 * allowances, which stay on `/api/account/entitlement`.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { CustomerPlanDto } from '@seo/contracts';
import { errorHandler } from '../../apiErrors.js';
import { plansRouter } from './plans.js';

const USER = 'aa000000-0000-4000-8000-000000000001';

const calls: string[] = [];

const catalog: CustomerPlanDto[] = [
  {
    key: 'base',
    name: 'Base',
    displayName: 'Free',
    description: null,
    isDefault: true,
    isPublic: true,
    sortOrder: 0,
    pricing: { currency: null, monthlyPrice: 0, yearlyPrice: 0, priceStatus: 'final', priceLabel: 'Free' },
    billingIntervals: ['monthly', 'yearly'],
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
      },
    ],
  },
];

let server: Server;
let base = '';

async function request(path: string, token?: string) {
  const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as { data?: CustomerPlanDto[]; error?: { code: string } },
  };
}

describe('customer plan catalog route', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      (req as unknown as { container: unknown }).container = {
        entitlements: {
          listCustomerPlans: async () => {
            calls.push('listCustomerPlans');
            return catalog;
          },
        },
      };
      (req as unknown as { user?: { sub: string } }).user = token === 'user-token' ? { sub: USER } : undefined;
      next();
    });
    app.use('/api/plans', plansRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects an anonymous request without reading the catalog', async () => {
    calls.length = 0;
    const res = await request('/api/plans');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('returns the public catalog to any authenticated user', async () => {
    calls.length = 0;
    const res = await request('/api/plans', 'user-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toHaveLength(1);
    expect(res.json.data?.[0]).toMatchObject({
      key: 'base',
      displayName: 'Free',
      pricing: { monthlyPrice: 0, priceStatus: 'final' },
      allowances: [{ resource: 'x_link_post', allowance: 0 }],
    });
    expect(calls).toEqual(['listCustomerPlans']);
  });
});
