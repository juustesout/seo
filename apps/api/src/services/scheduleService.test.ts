import { describe, expect, it } from 'vitest';
import type { ServiceContainer } from '../context.js';
import type { JobStore, JobRecord, EnqueueJobInput } from '../jobs/types.js';
import { ScheduleService, scheduleIdempotencyKey, syncScheduleStatus } from './scheduleService.js';
import { ApiError } from '../apiErrors.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const now = Date.now();
const inOneDay = new Date(now + 86400_000).toISOString();
const inTwoDays = new Date(now + 172800_000).toISOString();
const inThePast = new Date(now - 3600_000).toISOString();

// ---------------------------------------------------------------------------
// Supabase-like client fake: chainable filters, insert/update into stores,
// select()/single()/maybeSingle() semantics close enough to PostgREST.
// ---------------------------------------------------------------------------

type Filter = { op: 'eq' | 'in' | 'is'; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const got = row[f.col];
    if (f.op === 'eq') return got === f.val;
    if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(got);
    if (f.op === 'is') return f.val === null ? got === null || got === undefined : got === f.val;
    return true;
  });
}

function fakeSb(stores: Store) {
  const from = (table: string): unknown => {
    const state: {
      filters: Filter[];
      op: 'read' | 'insert' | 'update';
      payload: Row;
      single: boolean;
      select: boolean;
      resolved: boolean;
    } = { filters: [], op: 'read', payload: {}, single: false, select: false, resolved: false };

    const compute = (): { data: Row | Row[] | null; error: null } => {
      state.resolved = true;
      const rows = stores[table] ?? [];
      if (state.op === 'insert') {
        const inserted: Row = {
          ...state.payload,
          created_at: state.payload.created_at ?? new Date().toISOString(),
          updated_at: state.payload.updated_at ?? new Date().toISOString(),
        };
        rows.push(inserted);
        return { data: inserted, error: null };
      }
      if (state.op === 'update') {
        const updated = rows.filter((r) => matches(r, state.filters));
        for (const r of updated) Object.assign(r, state.payload);
        return { data: state.select ? updated : null, error: null };
      }
      const filtered = rows.filter((r) => matches(r, state.filters));
      return { data: state.single ? (filtered[0] ?? null) : filtered, error: null };
    };

    const b = {
      select: () => {
        state.select = true;
        return b;
      },
      eq: (col: string, val: unknown) => {
        state.filters.push({ op: 'eq', col, val });
        return b;
      },
      in: (col: string, vals: unknown[]) => {
        state.filters.push({ op: 'in', col, val: vals });
        return b;
      },
      is: (col: string, val: unknown) => {
        state.filters.push({ op: 'is', col, val });
        return b;
      },
      ilike: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => {
        state.single = true;
        return b;
      },
      single: () => {
        state.single = true;
        return b;
      },
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
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        state.resolved ? Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected) : Promise.resolve(compute()).then(onFulfilled, onRejected),
    };
    return b;
  };

  return { from: (table: string) => from(table) as { from: never } };
}

// ---------------------------------------------------------------------------
// Job store fake
// ---------------------------------------------------------------------------

class FakeJobStore implements JobStore {
  records: JobRecord[] = [];
  cancelCount = 0;
  private seq = 0;
  private keys = new Map<string, string | null>();

  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const id = `job-${++this.seq}`;
    const record: JobRecord = {
      id,
      project_id: input.project_id,
      integration_id: input.integration_id ?? null,
      data_source_id: input.data_source_id ?? null,
      provider: input.provider,
      job_type: input.job_type,
      status: 'queued',
      params: input.params ?? {},
      progress: 0,
      message: null,
      result: null,
      error: null,
      queued_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      run_after: input.run_after ?? new Date().toISOString(),
      retry_count: 0,
      max_retries: input.max_retries ?? 3,
      created_by: input.created_by ?? null,
    };
    this.records.push(record);
    this.keys.set(id, input.idempotency_key ?? null);
    return record;
  }

  keyOf(id: string): string | null {
    return this.keys.get(id) ?? null;
  }

  async get(id: string): Promise<JobRecord | null> {
    return this.records.find((r) => r.id === id) ?? null;
  }

  async list(): Promise<JobRecord[]> {
    return [...this.records];
  }

  async claimNext(): Promise<JobRecord | null> {
    const due = this.records.find((r) => r.status === 'queued' && r.run_after <= new Date().toISOString());
    if (!due) return null;
    due.status = 'running';
    due.started_at = new Date().toISOString();
    return due;
  }

  async updateProgress(): Promise<void> {}
  async complete(): Promise<void> {}
  async fail(): Promise<void> {}

  async cancel(id: string): Promise<void> {
    this.cancelCount += 1;
    const r = this.records.find((x) => x.id === id);
    if (r) {
      r.status = 'canceled';
      r.completed_at = new Date().toISOString();
    }
  }

  async reschedule(id: string, runAfter: string): Promise<boolean> {
    const r = this.records.find((x) => x.id === id);
    if (r && r.status === 'queued') {
      r.run_after = runAfter;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function container(stores: Store, jobStore: JobStore = new FakeJobStore()): ServiceContainer {
  return {
    config: { env: {} },
    registry: {},
    sb: fakeSb(stores) as never,
    jobStore,
  } as unknown as ServiceContainer;
}

function contentRow(id: string, projectId: string, title = 'Demo article') {
  return {
    id,
    project_id: projectId,
    title,
    slug: 'demo-article',
    excerpt: null,
    meta_description: 'A demo description',
    content_json: { type: 'doc', content: [] },
    content_html: '<p>Hello world</p>',
    status: 'draft',
  };
}

function publisherRow(id: string, projectId: string, overrides: Row = {}) {
  return {
    id,
    project_id: projectId,
    name: 'WordPress site',
    provider: 'wordpress',
    status: 'connected',
    ...overrides,
  };
}

function baseStores(): Store {
  return {
    seo_schedules: [],
    seo_content: [contentRow('c1', 'p1'), contentRow('c2', 'p2')],
    seo_publishers: [
      publisherRow('pb1', 'p1'),
      publisherRow('pb-other', 'p1', { name: 'Offline publisher', status: 'disconnected' }),
      publisherRow('pb2', 'p2'),
    ],
    seo_publications: [],
  };
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected ApiError with code '${code}'`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScheduleService.create', () => {
  it('creates exactly one due-time publish job per schedule (run_after, idempotency, job link)', async () => {
    const stores = baseStores();
    const jobStore = new FakeJobStore();
    const svc = new ScheduleService(container(stores, jobStore));

    const dto = await svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb1', scheduled_at: inOneDay });

    expect(dto).toMatchObject({
      project_id: 'p1',
      content_id: 'c1',
      content_title: 'Demo article',
      publisher_id: 'pb1',
      publisher_name: 'WordPress site',
      status: 'scheduled',
      scheduled_at: inOneDay,
    });
    expect(dto.job_id).toBe('job-1');

    expect(stores.seo_schedules).toHaveLength(1);
    expect(stores.seo_schedules[0].status).toBe('scheduled');
    expect(stores.seo_schedules[0].job_id).toBe('job-1');
    expect(stores.seo_schedules[0].created_by).toBe('u1');

    expect(jobStore.records).toHaveLength(1);
    const job = jobStore.records[0];
    expect(job.job_type).toBe('publish');
    expect(job.provider).toBe('wordpress');
    expect(job.run_after).toBe(inOneDay);
    expect(jobStore.keyOf('job-1')).toBe(scheduleIdempotencyKey(dto.id));
    expect(job.params).toMatchObject({
      schedule_id: dto.id,
      remote_status: 'publish',
    });

    expect(stores.seo_publications).toHaveLength(1);
    const pub = stores.seo_publications[0];
    expect(pub).toMatchObject({
      schedule_id: dto.id,
      content_id: 'c1',
      publisher_id: 'pb1',
      title: 'Demo article',
      content: '<p>Hello world</p>',
      excerpt: 'A demo description',
      scheduled_for: inOneDay,
    });
  });

  it('rejects content that belongs to another project', async () => {
    const stores = baseStores();
    const jobStore = new FakeJobStore();
    const svc = new ScheduleService(container(stores, jobStore));

    await expectErrorCode(svc.create('p1', 'u1', { content_id: 'c2', publisher_id: 'pb1', scheduled_at: inOneDay }), 'content_not_found');
    expect(stores.seo_schedules).toHaveLength(0);
    expect(stores.seo_publications).toHaveLength(0);
    expect(jobStore.records).toHaveLength(0);
  });

  it('rejects a publisher from another project', async () => {
    const stores = baseStores();
    const jobStore = new FakeJobStore();
    const svc = new ScheduleService(container(stores, jobStore));

    await expectErrorCode(svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb2', scheduled_at: inOneDay }), 'publisher_not_found');
    expect(stores.seo_schedules).toHaveLength(0);
    expect(jobStore.records).toHaveLength(0);
  });

  it('rejects a publisher that is not connected', async () => {
    const stores = baseStores();
    const jobStore = new FakeJobStore();
    const svc = new ScheduleService(container(stores, jobStore));

    await expectErrorCode(svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb-other', scheduled_at: inOneDay }), 'publisher_not_available');
    expect(stores.seo_schedules).toHaveLength(0);
    expect(jobStore.records).toHaveLength(0);
  });

  it('rejects invalid or past scheduled_at without any side effects', async () => {
    const stores = baseStores();
    const jobStore = new FakeJobStore();
    const svc = new ScheduleService(container(stores, jobStore));

    await expectErrorCode(svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb1', scheduled_at: 'not-a-date' }), 'invalid_schedule_time');
    await expectErrorCode(svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb1', scheduled_at: inThePast }), 'invalid_schedule_time');
    expect(stores.seo_schedules).toHaveLength(0);
    expect(stores.seo_publications).toHaveLength(0);
    expect(jobStore.records).toHaveLength(0);
  });
});

describe('ScheduleService.reschedule', () => {
  it('moves a future schedule to a new time on the same job (no second job)', async () => {
    const stores = baseStores();
    const jobStore = new FakeJobStore();
    const svc = new ScheduleService(container(stores, jobStore));

    const dto = await svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb1', scheduled_at: inOneDay });
    const moved = await svc.reschedule('p1', dto.id, inTwoDays);

    expect(moved.scheduled_at).toBe(inTwoDays);
    expect(moved.status).toBe('scheduled');
    expect(moved.id).toBe(dto.id);
    expect(jobStore.records).toHaveLength(1);
    expect(jobStore.records[0].run_after).toBe(inTwoDays);
    expect(stores.seo_schedules).toHaveLength(1);
    expect(stores.seo_schedules[0].scheduled_at).toBe(inTwoDays);
    expect(stores.seo_publications).toHaveLength(1);
  });

  it('rejects rescheduling once the schedule has started publishing', async () => {
    const stores = baseStores();
    const jobStore = new FakeJobStore();
    const svc = new ScheduleService(container(stores, jobStore));

    const dto = await svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb1', scheduled_at: inOneDay });
    stores.seo_schedules[0].status = 'publishing';

    await expectErrorCode(svc.reschedule('p1', dto.id, inTwoDays), 'schedule_not_editable');
    expect(jobStore.records[0].run_after).toBe(inOneDay);
  });
});

describe('ScheduleService.cancel', () => {
  it('cancels the schedule and prevents its job from executing', async () => {
    const stores = baseStores();
    const jobStore = new FakeJobStore();
    const svc = new ScheduleService(container(stores, jobStore));

    const dto = await svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb1', scheduled_at: inOneDay });
    const cancelled = await svc.cancel('p1', dto.id);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelled_at).toBeTruthy();
    expect(stores.seo_schedules[0].status).toBe('cancelled');
    expect((await jobStore.get('job-1'))?.status).toBe('canceled');
    expect(await jobStore.claimNext()).toBeNull();
    expect(stores.seo_publications).toHaveLength(1);
    expect(stores.seo_content).toHaveLength(2);
  });

  it('is idempotent (cancelling an already-cancelled schedule is a no-op success)', async () => {
    const stores = baseStores();
    const jobStore = new FakeJobStore();
    const svc = new ScheduleService(container(stores, jobStore));

    const dto = await svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb1', scheduled_at: inOneDay });
    await svc.cancel('p1', dto.id);
    const again = await svc.cancel('p1', dto.id);

    expect(again.status).toBe('cancelled');
    expect(jobStore.cancelCount).toBe(1);
    expect(stores.seo_schedules).toHaveLength(1);
  });

  it('rejects cancelling a schedule that is publishing', async () => {
    const stores = baseStores();
    const svc = new ScheduleService(container(stores));
    const dto = await svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb1', scheduled_at: inOneDay });
    stores.seo_schedules[0].status = 'publishing';

    await expectErrorCode(svc.cancel('p1', dto.id), 'schedule_not_cancellable');
    expect(stores.seo_schedules[0].status).toBe('publishing');
  });

  it('rejects cancelling a schedule that already published', async () => {
    const stores = baseStores();
    const svc = new ScheduleService(container(stores));
    const dto = await svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb1', scheduled_at: inOneDay });
    stores.seo_schedules[0].status = 'published';

    await expectErrorCode(svc.cancel('p1', dto.id), 'schedule_not_cancellable');
  });
});

describe('ScheduleService isolation + status sync', () => {
  it('only lists schedules that belong to the requesting project', async () => {
    const stores = baseStores();
    stores.seo_schedules = [
      {
        id: 's-p1',
        project_id: 'p1',
        content_id: 'c1',
        publisher_id: 'pb1',
        scheduled_at: inOneDay,
        status: 'scheduled',
        job_id: 'j1',
        created_by: 'u1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        cancelled_at: null,
      },
      {
        id: 's-p2',
        project_id: 'p2',
        content_id: 'c2',
        publisher_id: 'pb2',
        scheduled_at: inOneDay,
        status: 'scheduled',
        job_id: 'j2',
        created_by: 'u1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        cancelled_at: null,
      },
    ];
    const svc = new ScheduleService(container(stores));

    const p1 = await svc.list('p1');
    const p2 = await svc.list('p2');
    expect(p1.map((s) => s.id)).toEqual(['s-p1']);
    expect(p2.map((s) => s.id)).toEqual(['s-p2']);
    expect(p1[0]).toMatchObject({ content_title: 'Demo article', publisher_name: 'WordPress site' });
  });

  it('cannot mutate another project schedule (scope enforced on reschedule/cancel)', async () => {
    const stores = baseStores();
    stores.seo_schedules = [
      {
        id: 's-p1',
        project_id: 'p1',
        content_id: 'c1',
        publisher_id: 'pb1',
        scheduled_at: inOneDay,
        status: 'scheduled',
        job_id: 'j1',
        created_by: 'u1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        cancelled_at: null,
      },
    ];
    const svc = new ScheduleService(container(stores));

    await expectErrorCode(svc.reschedule('p2', 's-p1', inTwoDays), 'schedule_not_found');
    await expectErrorCode(svc.cancel('p2', 's-p1'), 'schedule_not_found');
    expect(stores.seo_schedules[0].status).toBe('scheduled');
  });

  it('syncs status only along non-terminal transitions (never un-cancels/un-publishes)', async () => {
    const stores = baseStores();
    const jobStore = new FakeJobStore();
    const svc = new ScheduleService(container(stores, jobStore));
    const dto = await svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb1', scheduled_at: inOneDay });
    const c = container(stores, jobStore);

    await syncScheduleStatus(c, { projectId: 'p1', scheduleId: dto.id, status: 'publishing' });
    expect(stores.seo_schedules[0].status).toBe('publishing');

    await syncScheduleStatus(c, { projectId: 'p1', scheduleId: dto.id, status: 'published' });
    expect(stores.seo_schedules[0].status).toBe('published');

    // A later stale sync must not flip a terminal state backwards.
    await syncScheduleStatus(c, { projectId: 'p1', scheduleId: dto.id, status: 'publishing' });
    expect(stores.seo_schedules[0].status).toBe('published');

    // Cancelled is terminal too.
    const second = await svc.create('p1', 'u1', { content_id: 'c1', publisher_id: 'pb1', scheduled_at: inTwoDays });
    await svc.cancel('p1', second.id);
    await syncScheduleStatus(c, { projectId: 'p1', scheduleId: second.id, status: 'publishing' });
    expect(stores.seo_schedules[1].status).toBe('cancelled');
  });
});
