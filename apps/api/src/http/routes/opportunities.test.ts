/**
 * Opportunity route tests (KW5 HTTP boundary).
 *
 * Mounts the real opportunitiesRouter over a fake container so the wire
 * contract is tested: authentication, viewer read, project isolation, the
 * `{ data }` envelope and bounded/invalid query rejection. The read must never
 * leak provider internals or cross project boundaries.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { competitorGapScope, scopeKeyOf } from '../../services/sourceScope.js';
import { opportunitiesRouter } from './opportunities.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';

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
      const orders: Array<{ col: string; asc: boolean }> = [];
      let limitN = Number.POSITIVE_INFINITY;
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orders.push({ col, asc: opts?.ascending !== false });
          return builder;
        },
        limit: (n: number) => {
          limitN = n;
          return builder;
        },
        maybeSingle: async () => {
          let out = all.filter((r) => filters.every((f) => f(r)));
          for (const { col, asc } of [...orders].reverse()) {
            out = [...out].sort((a, b) => {
              const av = a[col] as string;
              const bv = b[col] as string;
              if (av === bv) return 0;
              return (av < bv ? -1 : 1) * (asc ? 1 : -1);
            });
          }
          return { data: out.slice(0, limitN)[0] ?? null, error: null };
        },
      };
      return builder;
    },
  };
}

function snapshotRow(projectId: string, competitors: string[] = ['rival.com'], domain = 'example.com') {
  const scope = competitorGapScope({ domain, competitors });
  return {
    id: 'snap-1',
    project_id: projectId,
    type: 'competitor_gap',
    provider: 'dataforseo',
    scope,
    scope_key: scopeKeyOf(scope),
    data: {
      gaps: [
        { keyword: 'buy blue widgets', searchVolume: 2400, difficulty: 53, cpc: 3.2, competitorDomain: 'rival.com', position: 3 },
      ],
      total: 1,
    },
    fetched_at: new Date().toISOString(),
    source_job_id: null,
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
    json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } },
  };
}

beforeEach(() => {
  currentStores = { seo_source_snapshots: [] };
});

describe('opportunity routes', () => {
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
    app.use(`/api/projects/:projectId/keyword`, opportunitiesRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${PROJECT}/keyword`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const set = 'competitors=rival.com&domain=example.com';

  it('rejects an anonymous read', async () => {
    const res = await request(`/opportunities?${set}`);
    expect(res.status).toBe(401);
  });

  it('requires a competitor set', async () => {
    const res = await request('/opportunities', 'viewer-token');
    expect(res.status).toBe(400);
  });

  it('rejects an over-cap competitor set', async () => {
    const res = await request('/opportunities?competitors=a.com,b.com,c.com,d.com', 'viewer-token');
    expect(res.status).toBe(400);
  });

  it('lets a viewer read the empty analysis when no snapshot exists for the set', async () => {
    const res = await request(`/opportunities?${set}`, 'viewer-token');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ snapshot: null, opportunities: [], total: 0, count: 0 });
  });

  it('lets a viewer read the analysis of the exact-set snapshot', async () => {
    currentStores.seo_source_snapshots = [snapshotRow(PROJECT)];
    const res = await request(`/opportunities?${set}`, 'viewer-token');
    expect(res.status).toBe(200);
    const data = res.json.data as {
      snapshot: { domain: string; competitors: string[] } | null;
      opportunities: Array<{ keyword: string; score: number }>;
      count: number;
    };
    expect(data.snapshot?.domain).toBe('example.com');
    expect(data.snapshot?.competitors).toEqual(['rival.com']);
    expect(data.opportunities).toHaveLength(1);
    expect(data.opportunities[0]!.keyword).toBe('buy blue widgets');
    expect(typeof data.opportunities[0]!.score).toBe('number');
    expect(data.count).toBe(1);
  });

  it('returns no snapshot when the requested set has no snapshot of its own', async () => {
    currentStores.seo_source_snapshots = [snapshotRow(PROJECT, ['other.com'])];
    const res = await request(`/opportunities?${set}`, 'viewer-token');
    expect(res.status).toBe(200);
    expect((res.json.data as { snapshot: unknown }).snapshot).toBeNull();
  });

  it('does not return another project snapshot', async () => {
    currentStores.seo_source_snapshots = [snapshotRow(OTHER_PROJECT)];
    const res = await request(`/opportunities?${set}`, 'viewer-token');
    expect(res.status).toBe(200);
    expect((res.json.data as { snapshot: unknown }).snapshot).toBeNull();
  });

  it('rejects an out-of-range limit at the edge', async () => {
    const res = await request(`/opportunities?${set}&limit=100000`, 'viewer-token');
    expect(res.status).toBe(400);
  });

  it('rejects an unknown sort field', async () => {
    const res = await request(`/opportunities?${set}&sort=nonsense`, 'viewer-token');
    expect(res.status).toBe(400);
  });

  it('rejects an unknown intent', async () => {
    const res = await request(`/opportunities?${set}&intent=bogus`, 'viewer-token');
    expect(res.status).toBe(400);
  });
});
