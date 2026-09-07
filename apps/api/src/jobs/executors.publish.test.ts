/**
 * Publish executor routing (Content Studio Phase H5).
 *
 * Proves the existing job executor resolves the adapter from the publisher's
 * provider id, so a "social" publisher flows through the exact same schedule ->
 * publication -> publish job -> worker -> adapter path as WordPress. The demo
 * social adapter is only present when the registry is built with
 * ENABLE_TEST_PUBLISHERS=true.
 */

import { describe, expect, it } from 'vitest';
import { getExecutor } from './executors.js';
import { buildRegistry } from '../providers/registry.js';
import type { ServiceContainer } from '../context.js';
import type { JobRecord } from './types.js';
import type { SeoWriter } from '../persistence/seoWriter.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

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

function container(registry: ReturnType<typeof buildRegistry>, sb: Store): ServiceContainer {
  return {
    config: { env: {} },
    sb: fakeSb(sb) as never,
    registry,
    credentials: {
      reader: () => ({ get: async () => null, set: async () => undefined, delete: async () => undefined }),
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
    expect(sbStores.seo_publications[0].status).toBe('published');
    expect(sbStores.seo_publications[0].remote_id).toMatch(/^demo:/);
    expect(sbStores.seo_publications[0].target_url).toBeNull();
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
    sbStores.seo_publications[0].remote_id = 'demo:abcdef123456';
    const reg = buildRegistry({ config: { ENABLE_TEST_PUBLISHERS: 'true' }, logger: silentLogger() });
    const c = container(reg, sbStores);

    const result = await executorFor('publish')({
      container: c,
      job: job({ job_type: 'publish_update', params: { publication_id: 'pub-1', remote_status: 'publish' } }),
      writer: {} as SeoWriter,
      report: async () => undefined,
    });

    expect(result.remoteId).toBe('demo:abcdef123456');
    expect(sbStores.seo_publications[0].status).toBe('updated');
    expect(sbStores.seo_publications[0].remote_id).toBe('demo:abcdef123456');
  });

  it('fails an X publish safely at the adapter and never marks the publication successful (Phase H6.1)', async () => {
    const sbStores = stores();
    sbStores.seo_publishers = [
      { id: 'pb-x', project_id: 'p1', provider: 'x', name: 'X', status: 'connected', config: {}, capabilities: ['publish_text', 'schedule'] },
    ];
    sbStores.seo_publications[0].publisher_id = 'pb-x';
    const reg = buildRegistry({ config: {}, logger: silentLogger() });
    const c = container(reg, sbStores);

    await expect(
      executorFor('publish')({
        container: c,
        job: job({ provider: 'x', params: { publication_id: 'pub-1', remote_status: 'publish' } }),
        writer: {} as SeoWriter,
        report: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'publisher_not_available' });

    expect(sbStores.seo_publications[0].status).toBe('queued');
    expect(sbStores.seo_publications[0].remote_id).toBeNull();
    expect(sbStores.seo_publications[0].target_url).toBeNull();
  });
});
