/**
 * GSC sync service tests.
 *
 * The service is the only place that decides when a gsc_sync is enqueued, so
 * these tests pin the idempotency contract: an idle project queues exactly one
 * job, an already queued/running sync is reused instead of duplicated, the
 * deterministic key advances once a run finishes, and the best-effort wrapper
 * never throws (the attach flow depends on that). A fake Supabase-like client
 * backs the shared enqueue gate's real resolution queries.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { JobRecord } from '../jobs/types.js';
import type { ServiceContainer } from '../context.js';
import { enqueueGscSyncIfIdle, tryEnqueueGscSync } from './gscSyncService.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const PROPERTY = '22222222-2222-4222-8222-222222222222';
const INTEGRATION = 'int-1';
const ACCOUNT = 'acc-1';

let stores: Store = {};
let enqueueCalls: Row[] = [];
let enqueueImpl: ((input: Row) => Promise<JobRecord>) | null = null;

function jobRow(overrides: Row = {}): Row {
  return {
    id: 'job-1',
    project_id: PROJECT,
    provider: 'gsc',
    job_type: 'gsc_sync',
    status: 'queued',
    params: {},
    progress: 0,
    message: null,
    result: null,
    error: null,
    queued_at: '2026-09-15T08:00:00.000Z',
    started_at: null,
    completed_at: null,
    run_after: '2026-09-15T08:00:00.000Z',
    retry_count: 0,
    max_retries: 3,
    created_by: 'editor-user',
    idempotency_key: null,
    ...overrides,
  };
}

/** Minimal builder mirroring only the query chain the service/gate actually use. */
function fakeSb() {
  return {
    from(table: string) {
      const all = stores[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN: number | null = null;
      const apply = (): Row[] => {
        let rows = all.filter((r) => filters.every((f) => f(r)));
        if (orderCol) {
          const col = orderCol;
          rows = [...rows].sort(
            (a, b) => (String(a[col]) > String(b[col]) ? 1 : String(a[col]) < String(b[col]) ? -1 : 0) * (orderAsc ? 1 : -1),
          );
        }
        if (limitN !== null) rows = rows.slice(0, limitN);
        return rows;
      };
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
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
        maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
      };
      return builder;
    },
  };
}

function container(): ServiceContainer {
  return {
    sb: fakeSb(),
    registry: { getDataSource: (id: string) => (id === 'gsc' ? { id: 'gsc' } : undefined) },
    jobStore: {
      enqueue: async (input: Row) => {
        enqueueCalls.push(input);
        if (enqueueImpl) return enqueueImpl(input);
        return jobRow({ id: 'job-new', job_type: input.job_type, project_id: input.project_id }) as unknown as JobRecord;
      },
    },
  } as unknown as ServiceContainer;
}

function baseStores(): Store {
  return {
    seo_sync_jobs: [],
    seo_project_properties: [{ project_id: PROJECT, property_id: PROPERTY, is_primary: true, created_at: '2026-01-01' }],
    seo_gsc_properties: [{ id: PROPERTY, integration_id: INTEGRATION }],
    seo_integrations: [{ id: INTEGRATION, project_id: null, account_id: ACCOUNT, provider_type: 'gsc', status: 'connected' }],
    seo_projects: [{ id: PROJECT, account_id: ACCOUNT }],
    seo_data_sources: [{ id: 'ds-1', project_id: PROJECT, provider_type: 'gsc', created_at: '2026-01-01' }],
  };
}

beforeEach(() => {
  stores = baseStores();
  enqueueCalls = [];
  enqueueImpl = null;
});

describe('enqueueGscSyncIfIdle', () => {
  it('enqueues exactly one gsc_sync for an idle project', async () => {
    const result = await enqueueGscSyncIfIdle(container(), { projectId: PROJECT, userId: 'editor-user' });

    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toMatchObject({
      project_id: PROJECT,
      provider: 'gsc',
      job_type: 'gsc_sync',
      created_by: 'editor-user',
      idempotency_key: `gsc_sync:${PROJECT}:initial`,
    });
    expect(result.reused).toBe(false);
  });

  it('reuses an already queued sync instead of creating a second one', async () => {
    stores.seo_sync_jobs = [jobRow({ id: 'job-queued', status: 'queued' })];
    const result = await enqueueGscSyncIfIdle(container(), { projectId: PROJECT, userId: 'editor-user' });

    expect(enqueueCalls).toHaveLength(0);
    expect(result.reused).toBe(true);
    expect(result.job.id).toBe('job-queued');
  });

  it('reuses an already running sync', async () => {
    stores.seo_sync_jobs = [jobRow({ id: 'job-running', status: 'running' })];
    const result = await enqueueGscSyncIfIdle(container(), { projectId: PROJECT, userId: 'editor-user' });

    expect(enqueueCalls).toHaveLength(0);
    expect(result.reused).toBe(true);
    expect(result.job.id).toBe('job-running');
  });

  it('does not reuse a finished sync and advances the idempotency key', async () => {
    stores.seo_sync_jobs = [jobRow({ id: 'job-done', status: 'completed', completed_at: '2026-09-15T09:00:00.000Z' })];
    const result = await enqueueGscSyncIfIdle(container(), { projectId: PROJECT, userId: 'editor-user' });

    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0].idempotency_key).toBe(`gsc_sync:${PROJECT}:job-done`);
    expect(result.reused).toBe(false);
  });

  it('recovers from a lost insert race by reusing the winner', async () => {
    enqueueImpl = async () => {
      stores.seo_sync_jobs = [jobRow({ id: 'job-winner', status: 'queued' })];
      throw Object.assign(new Error('duplicate'), { code: 'conflict', status: 409 });
    };
    const result = await enqueueGscSyncIfIdle(container(), { projectId: PROJECT, userId: 'editor-user' });

    expect(result.reused).toBe(true);
    expect(result.job.id).toBe('job-winner');
  });
});

describe('tryEnqueueGscSync', () => {
  it('never throws when the sync cannot be queued', async () => {
    enqueueImpl = async () => {
      throw new Error('queue unavailable');
    };
    const result = await tryEnqueueGscSync(container(), { projectId: PROJECT, userId: 'editor-user' });
    expect(result).toBeNull();
  });
});
