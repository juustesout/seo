/**
 * Project GSC keywords route tests (KW1 HTTP boundary).
 *
 * Mounts the real projectGscRouter (only the /keywords endpoint is exercised)
 * over a fake container + Supabase-like client, so the wire contract is tested
 * end to end: authentication, viewer read access, the `{ data }` envelope, the
 * honest no-property payload, validation of dates/limits and project/property
 * isolation. Error responses must stay generic - no database internals leak.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { projectGscRouter } from './projectGsc.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const PROPERTY = '22222222-2222-4222-8222-222222222222';
const OTHER_PROPERTY = '33333333-3333-4333-8333-333333333333';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'viewer-user' },
  'norole-token': { sub: 'no-role-user' },
};
const ROLE_BY_USER: Record<string, string | undefined> = { 'viewer-user': 'viewer' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

let currentStores: Store = {};

function fakeSb() {
  return {
    from(table: string) {
      const all = currentStores[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN: number | null = null;
      let rangeFrom: number | null = null;
      let rangeTo: number | null = null;
      const apply = (): Row[] => {
        let rows = all.filter((r) => filters.every((f) => f(r)));
        if (orderCol) {
          const col = orderCol;
          rows = [...rows].sort((a, b) => {
            const av = a[col] as string | number;
            const bv = b[col] as string | number;
            if (av === bv) return 0;
            return (av > bv ? 1 : -1) * (orderAsc ? 1 : -1);
          });
        }
        if (rangeFrom !== null && rangeTo !== null) rows = rows.slice(rangeFrom, rangeTo + 1);
        else if (limitN !== null) rows = rows.slice(0, limitN);
        return rows;
      };
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        gte: (col: string, val: unknown) => {
          filters.push((r) => String(r[col]) >= String(val));
          return builder;
        },
        lte: (col: string, val: unknown) => {
          filters.push((r) => String(r[col]) <= String(val));
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return builder;
        },
        limit: (n: number) => {
          limitN = n;
          return builder;
        },
        range: (from: number, to: number) => {
          rangeFrom = from;
          rangeTo = to;
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: apply(), error: null }),
      };
      return builder;
    },
  };
}

function queryRow(overrides: Row = {}): Row {
  return {
    project_id: PROJECT,
    property_id: PROPERTY,
    query: 'seo',
    clicks: 1,
    impressions: 10,
    position: 5,
    date: '2026-09-01',
    ...overrides,
  };
}

function defaultStores(): Store {
  return {
    seo_project_properties: [{ project_id: PROJECT, property_id: PROPERTY, is_primary: true, created_at: '2026-01-01' }],
    seo_gsc_queries: [],
    seo_data_sources: [{ project_id: PROJECT, provider_type: 'gsc', last_synced_at: '2026-09-12T08:00:00.000Z' }],
  };
}

let server: Server;
let base = '';

async function request(path: string, token?: string) {
  const res = await fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } } };
}

beforeEach(() => {
  currentStores = defaultStores();
});

describe('GET /api/projects/:projectId/gsc/keywords', () => {
  beforeAll(async () => {
    const app = express();
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
        config: { env: {} },
        sb: fakeSb(),
        registry: {},
        jobStore: {},
      };
      (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
      next();
    });
    app.use(`/api/projects/:projectId/gsc`, projectGscRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${PROJECT}/gsc`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects an anonymous request', async () => {
    const res = await request('/keywords');
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe('unauthorized');
  });

  it('rejects an authenticated non-member', async () => {
    const res = await request('/keywords', 'norole-token');
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe('forbidden');
  });

  it('lets a viewer read aggregated keywords for the linked property', async () => {
    currentStores.seo_gsc_queries = [
      queryRow({ query: 'seo tools', clicks: 5, impressions: 100, position: 4, date: '2026-09-02' }),
      queryRow({ query: 'seo tools', clicks: 3, impressions: 300, position: 8, date: '2026-09-03' }),
      queryRow({ query: 'other project', project_id: '44444444-4444-4444-8444-444444444444', clicks: 99, impressions: 9999 }),
      queryRow({ query: 'other property', property_id: OTHER_PROPERTY, clicks: 99, impressions: 9999 }),
    ];
    const res = await request('/keywords', 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({
      propertyId: PROPERTY,
      lastSyncedAt: '2026-09-12T08:00:00.000Z',
      keywords: [{ keyword: 'seo tools', clicks: 8, impressions: 400, ctr: 0.02, position: 7 }],
    });
  });

  it('returns an honest empty payload when no property is linked', async () => {
    currentStores.seo_project_properties = [];
    currentStores.seo_gsc_queries = [queryRow()];
    const res = await request('/keywords', 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ propertyId: null, lastSyncedAt: null, keywords: [] });
  });

  it('rejects a malformed or reversed date range with a safe error', async () => {
    const malformed = await request('/keywords?startDate=2026-02-30', 'viewer-token');
    expect(malformed.status).toBe(400);
    expect(malformed.json.error?.code).toBe('bad_request');

    const reversed = await request('/keywords?startDate=2026-09-10&endDate=2026-09-01', 'viewer-token');
    expect(reversed.status).toBe(400);
    expect(reversed.json.error?.message).toBe('startDate must be on or before endDate');
  });
});
