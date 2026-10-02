/**
 * Publications API idempotency (R5.11.2 H3).
 *
 * Duplicate and concurrent submissions of the same logical publish operation
 * must resolve to one durable job, a genuinely new document/payload must still
 * create a new operation, and a lifecycle action against an already-published
 * row must be refused instead of issuing a second remote create.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import type { EnqueueJobInput } from '../../jobs/types.js';
import { publicationsRouter } from './publications.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const PUBLISHER = '33333333-3333-4333-8333-333333333333';
const PUBLICATION = '22222222-2222-4222-8222-222222222222';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'viewer-user' },
  'editor-token': { sub: 'editor-user' },
};
const ROLE_BY_USER: Record<string, string | undefined> = { 'viewer-user': 'viewer', 'editor-user': 'editor' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

type Row = Record<string, unknown>;
type Store = Record<string, Row[]> & {
  seo_publishers: Row[];
  seo_publications: Row[];
  seo_sync_jobs: Row[];
};

let stores: Store;
let enqueued: EnqueueJobInput[];
let publicationSeq: number;
let jobSeq: number;

function seed(): Store {
  return {
    seo_publishers: [
      { id: PUBLISHER, project_id: PROJECT, provider: 'wordpress', name: 'Blog', status: 'connected', config: {}, capabilities: [] },
    ],
    seo_publications: [],
    seo_sync_jobs: [],
  };
}

// In-memory PostgREST-like fake: chainable eq/in/like filters, insert/update,
// select/maybeSingle/single and thenable reads - enough for the publication
// route + the identity lookup service.
function fakeSb() {
  const from = (table: string): unknown => {
    const state: {
      filters: Array<(row: Row) => boolean>;
      op: 'read' | 'insert' | 'update';
      payload: Row;
      single: boolean;
    } = { filters: [], op: 'read', payload: {}, single: false };

    const compute = (): { data: Row | Row[] | null; error: null } => {
      const rows = stores[table] ?? [];
      if (state.op === 'insert') {
        const inserted: Row = {
          id: table === 'seo_publications' ? `pub-${++publicationSeq}` : `${table}-${++jobSeq}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...state.payload,
        };
        rows.push(inserted);
        return { data: state.single ? inserted : [inserted], error: null };
      }
      if (state.op === 'update') {
        const updated = rows.filter((r) => state.filters.every((f) => f(r)));
        for (const r of updated) Object.assign(r, state.payload);
        return { data: state.single ? (updated[0] ?? null) : updated, error: null };
      }
      const filtered = rows.filter((r) => state.filters.every((f) => f(r)));
      return { data: state.single ? (filtered[0] ?? null) : filtered, error: null };
    };

    const b = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        state.filters.push((row) => row[col] === val);
        return b;
      },
      in: (col: string, vals: unknown[]) => {
        state.filters.push((row) => Array.isArray(vals) && vals.includes(row[col]));
        return b;
      },
      like: (col: string, pattern: string) => {
        const prefix = pattern.endsWith('%') ? pattern.slice(0, -1) : pattern;
        state.filters.push((row) => String(row[col] ?? '').startsWith(prefix));
        return b;
      },
      order: () => b,
      limit: () => b,
      insert: (payload: Row) => {
        state.op = 'insert';
        state.payload = payload;
        return b;
      },
      update: (payload: Row) => {
        state.op = 'update';
        state.payload = payload;
        return b;
      },
      maybeSingle: () => {
        state.single = true;
        return b;
      },
      single: () => {
        state.single = true;
        return b;
      },
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(compute()).then(onFulfilled, onRejected),
    };
    return b;
  };
  return { from: (table: string) => from(table) as { from: never } };
}

function fakeJobStore() {
  return {
    list: async () => [],
    enqueue: async (input: EnqueueJobInput) => {
      const key = input.idempotency_key ?? null;
      if (key && stores.seo_sync_jobs.some((r) => r.idempotency_key === key)) {
        throw ApiError.conflict('A job with the same idempotency key already exists');
      }
      const row: Row = {
        id: `job-${++jobSeq}`,
        project_id: input.project_id,
        provider: input.provider,
        job_type: input.job_type,
        status: 'queued',
        params: input.params ?? {},
        queued_at: new Date().toISOString(),
        run_after: input.run_after ?? new Date().toISOString(),
        retry_count: 0,
        max_retries: 3,
        idempotency_key: key,
      };
      stores.seo_sync_jobs.push(row);
      enqueued.push(input);
      return row;
    },
  };
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
    json: (await res.json().catch(() => null)) as {
      data?: { publication?: Row; job?: Row; reused?: boolean; publicationId?: string };
      error?: { code: string; message: string };
    },
  };
}

let server: Server;
let base = '';
const publicationBody = { publisher_id: PUBLISHER, publish_kind: 'article', title: 'Hello world', content: '<p>Body</p>' };

beforeEach(() => {
  stores = seed();
  enqueued = [];
  publicationSeq = 0;
  jobSeq = 0;
});

describe('publications route idempotency', () => {
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
        sb: fakeSb(),
        jobStore: fakeJobStore(),
      };
      (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
      next();
    });
    app.use('/api/projects/:projectId/publications', publicationsRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${PROJECT}/publications`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects an anonymous request', async () => {
    const res = await request('/', { method: 'POST', body: publicationBody });
    expect(res.status).toBe(401);
    expect(stores.seo_sync_jobs).toHaveLength(0);
  });

  it('blocks a viewer from creating a publication', async () => {
    const res = await request('/', { token: 'viewer-token', method: 'POST', body: publicationBody });
    expect(res.status).toBe(403);
    expect(stores.seo_sync_jobs).toHaveLength(0);
  });

  it('enqueues one deterministic publish job for the first submission', async () => {
    const res = await request('/', { token: 'editor-token', method: 'POST', body: publicationBody });
    expect(res.status).toBe(202);
    expect(res.json.data?.reused).toBe(false);
    expect(stores.seo_publications).toHaveLength(1);
    expect(stores.seo_sync_jobs).toHaveLength(1);
    expect(String(stores.seo_sync_jobs[0]!.idempotency_key)).toMatch(/^publish:create:/);
  });

  it('collapses a repeated identical submission onto the in-flight job', async () => {
    const first = await request('/', { token: 'editor-token', method: 'POST', body: publicationBody });
    const second = await request('/', { token: 'editor-token', method: 'POST', body: publicationBody });
    expect(second.status).toBe(202);
    expect(second.json.data?.reused).toBe(true);
    expect(second.json.data?.job?.id).toBe(first.json.data?.job?.id);
    expect(stores.seo_sync_jobs).toHaveLength(1);
  });

  it('collapses two concurrent identical submissions onto one job', async () => {
    const [a, b] = await Promise.all([
      request('/', { token: 'editor-token', method: 'POST', body: publicationBody }),
      request('/', { token: 'editor-token', method: 'POST', body: publicationBody }),
    ]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.json.data?.job?.id).toBe(b.json.data?.job?.id);
    expect(stores.seo_sync_jobs).toHaveLength(1);
    expect([a.json.data?.reused, b.json.data?.reused]).toContain(true);
  });

  it('treats a changed payload as a genuinely new operation', async () => {
    await request('/', { token: 'editor-token', method: 'POST', body: publicationBody });
    const changed = await request('/', {
      token: 'editor-token',
      method: 'POST',
      body: { ...publicationBody, content: '<p>Different body</p>' },
    });
    expect(changed.status).toBe(202);
    expect(changed.json.data?.reused).toBe(false);
    expect(stores.seo_sync_jobs).toHaveLength(2);
  });

  it('schedules the job and the publication when schedule_for is supplied', async () => {
    const when = new Date(Date.now() + 3600_000).toISOString();
    const res = await request('/', {
      token: 'editor-token',
      method: 'POST',
      body: { ...publicationBody, schedule_for: when },
    });
    expect(res.status).toBe(202);
    expect(stores.seo_publications[0]!.status).toBe('scheduled');
    expect(stores.seo_sync_jobs).toHaveLength(1);
    expect(new Date(String(stores.seo_sync_jobs[0]!.run_after)).getTime()).toBe(new Date(when).getTime());
  });

  it('reuses an in-flight action job and refuses publishing an already-created row', async () => {
    stores.seo_publications.push({
      id: PUBLICATION,
      project_id: PROJECT,
      publisher_id: PUBLISHER,
      status: 'failed',
      title: 'Hello',
      remote_id: null,
    });
    const first = await request(`/${PUBLICATION}/actions`, {
      token: 'editor-token',
      method: 'POST',
      body: { action: 'publish' },
    });
    const second = await request(`/${PUBLICATION}/actions`, {
      token: 'editor-token',
      method: 'POST',
      body: { action: 'publish' },
    });
    expect(first.status).toBe(202);
    expect(second.json.data?.reused).toBe(true);
    expect(stores.seo_sync_jobs).toHaveLength(1);

    stores.seo_publications[0]!.remote_id = 'remote-1';
    const conflict = await request(`/${PUBLICATION}/actions`, {
      token: 'editor-token',
      method: 'POST',
      body: { action: 'publish' },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error?.code).toBe('conflict');
  });
});
