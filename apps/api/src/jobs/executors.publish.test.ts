/**
 * Publish executor routing (Content Studio Phase H5).
 *
 * Proves the existing job executor resolves the adapter from the publisher's
 * provider id, so a "social" publisher flows through the exact same schedule ->
 * publication -> publish job -> worker -> adapter path as WordPress. The demo
 * social adapter is only present when the registry is built with
 * ENABLE_TEST_PUBLISHERS=true.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExecutor } from './executors.js';
import { buildRegistry } from '../providers/registry.js';
import { InMemoryUsageEventStore } from '../services/usageEventRepository.js';
import type { ServiceContainer } from '../context.js';
import type { JobRecord } from './types.js';
import type { SeoWriter } from '../persistence/seoWriter.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]> & {
  seo_publications: Row[];
  seo_publishers: Row[];
};

function silentLogger() {
  const noop = () => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop };
}

function executorFor(type: string) {
  const executor = getExecutor(type);
  if (!executor) throw new Error(`No executor registered for ${type}`);
  return executor;
}

// Supabase-like fake: chainable filters for the queries the publish executor
// issues (publication + publisher lookup, terminal publication update).
function fakeSb(stores: Store) {
  const from = (table: string): unknown => {
    const state: {
      filters: Array<{ col: string; val: unknown }>;
      op: 'read' | 'update';
      payload: Row;
      single: boolean;
    } = { filters: [], op: 'read', payload: {}, single: false };

    const compute = (): { data: Row | Row[] | null; error: null } => {
      const rows = stores[table] ?? [];
      const matches = (r: Row) => state.filters.every((f) => r[f.col] === f.val);
      if (state.op === 'update') {
        const updated = rows.filter(matches);
        for (const r of updated) Object.assign(r, state.payload);
        return { data: state.single ? (updated[0] ?? null) : updated, error: null };
      }
      const filtered = rows.filter(matches);
      return { data: state.single ? (filtered[0] ?? null) : filtered, error: null };
    };

    const b = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        state.filters.push({ col, val });
        return b;
      },
      maybeSingle: () => {
        state.single = true;
        return b;
      },
      update: (payload: Row) => {
        state.op = 'update';
        state.payload = payload;
        return b;
      },
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(compute()).then(onFulfilled, onRejected),
    };
    return b;
  };

  return { from: (table: string) => from(table) as { from: never } };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    project_id: 'p1',
    integration_id: null,
    data_source_id: null,
    provider: 'mock_social',
    job_type: 'publish',
    status: 'running',
    params: { publication_id: 'pub-1', remote_status: 'publish' },
    progress: 0,
    message: null,
    result: null,
    error: null,
    queued_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    run_after: new Date().toISOString(),
    retry_count: 0,
    max_retries: 3,
    created_by: null,
    ...overrides,
  };
}

function container(
  registry: unknown,
  sb: Store,
  usageEvents: ServiceContainer['usageEvents'] = new InMemoryUsageEventStore(),
  credentials: Record<string, string> = {},
  entitlements: unknown = { withAdmission: async (_req: unknown, fn: () => Promise<unknown>) => fn() },
): ServiceContainer {
  return {
    config: { env: {} },
    sb: fakeSb(sb) as never,
    registry,
    usageEvents,
    entitlements,
    credentials: {
      reader: () => ({
        get: async (key: string) => credentials[key] ?? null,
        set: async () => undefined,
        delete: async () => undefined,
      }),
    },
  } as unknown as ServiceContainer;
}

function stores(): Store {
  return {
    seo_publications: [
      {
        id: 'pub-1',
        project_id: 'p1',
        publisher_id: 'pb-1',
        content_id: 'c1',
        status: 'queued',
        title: 'Demo article',
        slug: 'demo-article',
        content: '<p>Hello <b>social</b> world</p>',
        excerpt: 'A demo description',
        remote_id: null,
        target_url: null,
        error: null,
      },
    ],
    seo_publishers: [
      { id: 'pb-1', project_id: 'p1', provider: 'mock_social', name: 'Social demo (mock)', status: 'connected', config: {} },
    ],
  };
}

describe('publish executor routing to a social publisher (Content Studio Phase H5)', () => {
  it('routes the publish job to the adapter of the publisher provider and records the demo result', async () => {
    const sbStores = stores();
    const reg = buildRegistry({ config: { ENABLE_TEST_PUBLISHERS: 'true' }, logger: silentLogger() });
    const c = container(reg, sbStores);

    const result = await executorFor('publish')({
      container: c,
      job: job(),
      writer: {} as SeoWriter,
      report: async () => undefined,
    });

    expect(result.remoteId).toMatch(/^demo:/);
    expect(sbStores.seo_publications[0]!.status).toBe('published');
    expect(sbStores.seo_publications[0]!.remote_id).toMatch(/^demo:/);
    expect(sbStores.seo_publications[0]!.target_url).toBeNull();
  });

  it('marks the linked seo_content row published once the adapter confirms', async () => {
    const sbStores = stores();
    sbStores.seo_content = [{ id: 'c1', project_id: 'p1', status: 'draft', published_at: null }];
    const reg = buildRegistry({ config: { ENABLE_TEST_PUBLISHERS: 'true' }, logger: silentLogger() });
    const c = container(reg, sbStores);

    await executorFor('publish')({
      container: c,
      job: job(),
      writer: {} as SeoWriter,
      report: async () => undefined,
    });

    expect(sbStores.seo_content[0]!.status).toBe('published');
    expect(typeof sbStores.seo_content[0]!.published_at).toBe('string');
  });

  it('leaves a standalone publication (no content_id) without touching seo_content', async () => {
    const sbStores = stores();
    sbStores.seo_publications[0]!.content_id = null;
    sbStores.seo_content = [{ id: 'c1', project_id: 'p1', status: 'draft', published_at: null }];
    const reg = buildRegistry({ config: { ENABLE_TEST_PUBLISHERS: 'true' }, logger: silentLogger() });
    const c = container(reg, sbStores);

    await executorFor('publish')({
      container: c,
      job: job(),
      writer: {} as SeoWriter,
      report: async () => undefined,
    });

    expect(sbStores.seo_content[0]!.status).toBe('draft');
    expect(sbStores.seo_content[0]!.published_at).toBeNull();
  });

  it('fails safely when the publisher provider is not registered (default production registry)', async () => {
    const sbStores = stores();
    const reg = buildRegistry({ config: {}, logger: silentLogger() });
    const c = container(reg, sbStores);

    await expect(
      executorFor('publish')({
        container: c,
        job: job(),
        writer: {} as SeoWriter,
        report: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('routes publish_update to the same social adapter and keeps the demo remote id', async () => {
    const sbStores = stores();
    sbStores.seo_publications[0]!.remote_id = 'demo:abcdef123456';
    const reg = buildRegistry({ config: { ENABLE_TEST_PUBLISHERS: 'true' }, logger: silentLogger() });
    const c = container(reg, sbStores);

    const result = await executorFor('publish')({
      container: c,
      job: job({ job_type: 'publish_update', params: { publication_id: 'pub-1', remote_status: 'publish' } }),
      writer: {} as SeoWriter,
      report: async () => undefined,
    });

    expect(result.remoteId).toBe('demo:abcdef123456');
    expect(sbStores.seo_publications[0]!.status).toBe('updated');
    expect(sbStores.seo_publications[0]!.remote_id).toBe('demo:abcdef123456');
  });

  it('fails an X publish safely when the account is not connected and never marks it successful (Phase H6.2)', async () => {
    const sbStores = stores();
    sbStores.seo_publishers = [
      { id: 'pb-x', project_id: 'p1', provider: 'x', name: 'X', status: 'disconnected', config: {}, capabilities: ['publish_text', 'schedule'] },
    ];
    sbStores.seo_publications[0]!.publisher_id = 'pb-x';
    const reg = buildRegistry({ config: {}, logger: silentLogger() });
    const c = container(reg, sbStores);

    await expect(
      executorFor('publish')({
        container: c,
        job: job({ provider: 'x', params: { publication_id: 'pub-1', remote_status: 'publish' } }),
        writer: {} as SeoWriter,
        report: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'publisher_auth_failed', retryable: false });

    expect(sbStores.seo_publications[0]!.status).toBe('queued');
    expect(sbStores.seo_publications[0]!.remote_id).toBeNull();
    expect(sbStores.seo_publications[0]!.target_url).toBeNull();
  });
});

describe('publish executor usage accounting (R5.10.6)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const PROJECT = '11111111-1111-4111-8111-111111111111';
  const USER = '33333333-3333-4333-8333-333333333333';

  function response(body: unknown, status = 200): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  function wordpressStores(): Store {
    const s = stores();
    s.seo_publications[0]!.project_id = PROJECT;
    s.seo_publishers = [
      { id: 'pb-1', project_id: PROJECT, provider: 'wordpress', name: 'Blog', status: 'connected', config: { base_url: 'https://blog.example.com' } },
    ];
    return s;
  }

  function wordpressJob(retryCount = 0): JobRecord {
    return job({ project_id: PROJECT, provider: 'wordpress', created_by: USER, retry_count: retryCount });
  }

  function run(c: ServiceContainer, j: JobRecord) {
    return executorFor('publish')({ container: c, job: j, writer: {} as SeoWriter, report: async () => undefined });
  }

  const creds = { wordpress_username: 'admin', wordpress_application_password: 'app-pass' };

  it('records one publish_attempt correlated to the job', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ id: 7, link: 'https://blog.example.com/?p=7' }, 201)));
    const sbStores = wordpressStores();
    const store = new InMemoryUsageEventStore();
    const c = container(buildRegistry({ config: {}, logger: silentLogger() }), sbStores, store, creds);

    const result = await run(c, wordpressJob());

    expect(result.remoteId).toBe('7');
    expect(sbStores.seo_publications[0]!.status).toBe('published');
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'publishing',
      provider: 'wordpress',
      operation: 'publish',
      unit: 'publish_attempt',
      success: true,
      sourceId: 'job-1',
      projectId: PROJECT,
      userId: USER,
    });
  });

  it('strides the occurrence so a retried execution is a distinct attempt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ id: 8, link: 'https://blog.example.com/?p=8' }, 201)));
    const store = new InMemoryUsageEventStore();
    const reg = buildRegistry({ config: {}, logger: silentLogger() });

    await run(container(reg, wordpressStores(), store, creds), wordpressJob(0));
    await run(container(reg, wordpressStores(), store, creds), wordpressJob(0));
    expect(await store.list({ projectId: PROJECT })).toHaveLength(1);

    await run(container(reg, wordpressStores(), store, creds), wordpressJob(1));
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.sourceId)).toEqual(['job-1', 'job-1']);
  });

  it('records nothing for the mock social publisher (no external request)', async () => {
    const sbStores = stores();
    const store = new InMemoryUsageEventStore();
    const reg = buildRegistry({ config: { ENABLE_TEST_PUBLISHERS: 'true' }, logger: silentLogger() });

    const result = await run(container(reg, sbStores, store), job());

    expect(result.remoteId).toMatch(/^demo:/);
    expect(await store.list({ projectId: 'p1' })).toHaveLength(0);
  });

  it('never fails a successful publication when the ledger append fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ id: 9, link: 'https://blog.example.com/?p=9' }, 201)));
    const sbStores = wordpressStores();
    const failing = {
      append: async () => {
        throw new Error('ledger down');
      },
      list: async () => [],
    } as unknown as ServiceContainer['usageEvents'];
    const c = container(buildRegistry({ config: {}, logger: silentLogger() }), sbStores, failing, creds);

    const result = await run(c, wordpressJob());

    expect(result.remoteId).toBe('9');
    expect(sbStores.seo_publications[0]!.status).toBe('published');
  });

  it('does not call the provider again when a retry finds a confirmed remote id (H3)', async () => {
    const fetchSpy = vi.fn(async () => response({ id: 42, link: 'https://blog.example.com/?p=42' }, 201));
    vi.stubGlobal('fetch', fetchSpy);
    const sbStores = wordpressStores();
    sbStores.seo_publications[0]!.status = 'published';
    sbStores.seo_publications[0]!.remote_id = '42';
    sbStores.seo_publications[0]!.target_url = 'https://blog.example.com/?p=42';
    const store = new InMemoryUsageEventStore();
    const c = container(buildRegistry({ config: {}, logger: silentLogger() }), sbStores, store, creds);

    const result = await run(c, wordpressJob(1));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.remoteId).toBe('42');
    expect(result.url).toBe('https://blog.example.com/?p=42');
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });

  it('does not issue a second remote delete when the row is already deleted (H3)', async () => {
    const fetchSpy = vi.fn(async () => response({}, 200));
    vi.stubGlobal('fetch', fetchSpy);
    const sbStores = wordpressStores();
    sbStores.seo_publications[0]!.status = 'deleted';
    sbStores.seo_publications[0]!.remote_id = '42';
    const c = container(buildRegistry({ config: {}, logger: silentLogger() }), sbStores, undefined, creds);

    const result = await executorFor('publish')({
      container: c,
      job: { ...wordpressJob(1), job_type: 'publish_delete' },
      writer: {} as SeoWriter,
      report: async () => undefined,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deleted: true, remoteId: '42' });
  });

  it('records a failed physical attempt and a later real retry as separate attempts', async () => {
    const fetchSpy = vi.fn(async () => response({ message: 'boom' }, 500));
    vi.stubGlobal('fetch', fetchSpy);
    const sbStores = wordpressStores();
    const store = new InMemoryUsageEventStore();
    const reg = buildRegistry({ config: {}, logger: silentLogger() });

    await expect(run(container(reg, sbStores, store, creds), wordpressJob(0))).rejects.toBeTruthy();
    expect(sbStores.seo_publications[0]!.remote_id).toBeNull();

    fetchSpy.mockImplementation(async () => response({ id: 11, link: 'https://blog.example.com/?p=11' }, 201));
    const result = await run(container(reg, sbStores, store, creds), wordpressJob(1));

    expect(result.remoteId).toBe('11');
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.success).sort()).toEqual([false, true]);
  });
});

/**
 * X link-post allowance enforcement (P14).
 *
 * An X post carrying a link carries a real per-post operator cost, so it must be
 * admitted against the `x_link_post` product allowance before the remote write;
 * a non-link post (cheap) must not, and a denial must stop the provider call.
 */
describe('publish executor X link-post allowance (P14)', () => {
  const PROJECT = '11111111-1111-4111-8111-111111111111';
  const USER = '33333333-3333-4333-8333-333333333333';

  function xStores(content: string): Store {
    const s = stores();
    s.seo_publications[0]!.project_id = PROJECT;
    s.seo_publications[0]!.content = content;
    s.seo_publishers = [
      { id: 'pb-1', project_id: PROJECT, provider: 'x', name: 'X', status: 'connected', config: {} },
    ];
    return s;
  }

  function xAdapter() {
    return {
      id: 'x',
      publish: vi.fn(async () => ({ remoteId: 'x-1', url: 'https://x.com/status/1' })),
      update: vi.fn(),
      delete: vi.fn(),
    };
  }

  function run(c: ServiceContainer) {
    return executorFor('publish')({
      container: c,
      job: job({ project_id: PROJECT, provider: 'x', created_by: USER }),
      writer: {} as SeoWriter,
      report: async () => undefined,
    });
  }

  it('admits an X link post against the allowance before the remote write', async () => {
    const admissions: Array<Record<string, unknown>> = [];
    const adapter = xAdapter();
    const c = container(
      { getPublisher: (id: string) => (id === 'x' ? adapter : null) },
      xStores('<p>Read more at https://example.com/post</p>'),
      undefined,
      {},
      { withAdmission: async (req: Record<string, unknown>, fn: () => Promise<unknown>) => (admissions.push(req), fn()) },
    );

    const result = await run(c);

    expect(result.remoteId).toBe('x-1');
    expect(admissions).toEqual([
      { projectId: PROJECT, userId: USER, resource: 'x_link_post', fundingSource: 'operator_funded' },
    ]);
    expect(adapter.publish).toHaveBeenCalledTimes(1);
  });

  it('does not consume the allowance for an X post without a link', async () => {
    const admissions: Array<Record<string, unknown>> = [];
    const adapter = xAdapter();
    const c = container(
      { getPublisher: (id: string) => (id === 'x' ? adapter : null) },
      xStores('<p>Plain text, no link here</p>'),
      undefined,
      {},
      { withAdmission: async (req: Record<string, unknown>, fn: () => Promise<unknown>) => (admissions.push(req), fn()) },
    );

    const result = await run(c);

    expect(result.remoteId).toBe('x-1');
    expect(admissions).toHaveLength(0);
    expect(adapter.publish).toHaveBeenCalledTimes(1);
  });

  it('denies an X link post before the remote write when the allowance is exhausted', async () => {
    const adapter = xAdapter();
    const c = container(
      { getPublisher: (id: string) => (id === 'x' ? adapter : null) },
      xStores('<p>Read more at https://example.com/post</p>'),
      undefined,
      {},
      {
        withAdmission: async () => {
          throw new Error('seo_entitlement_limit');
        },
      },
    );

    await expect(run(c)).rejects.toThrow('seo_entitlement_limit');
    expect(adapter.publish).not.toHaveBeenCalled();
  });
});
