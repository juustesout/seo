/**
 * gsc_sync executor usage correlation (R5.10.5).
 *
 * Pins the job wiring gap the recon found: the executor must pass
 * `usageSourceId: job.id` so every GSC request the job makes carries a stable
 * source identity, and multiple requests in one job get distinct occurrences.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLogger } from '@seo/contracts';
import { getExecutor } from './executors.js';
import { GscDataSource } from '../providers/gsc/gscDataSource.js';
import { InMemoryUsageEventStore } from '../services/usageEventRepository.js';

vi.mock('../util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util.js')>();
  return { ...actual, delay: async () => {} };
});

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const SITE = 'https://example.com/';
const noopLogger: ProviderLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function chain(data: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'neq', 'order', 'limit', 'gte', 'in']) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = async () => ({ data, error: null });
  builder.single = async () => ({ data, error: null });
  return builder;
}

function container(store: InMemoryUsageEventStore, reader: ProviderContextReader) {
  const rows: Record<string, unknown> = {
    seo_data_sources: { id: 'ds-1', integration_id: 'int-1', config: { siteUrl: SITE } },
    seo_project_properties: { property_id: 'prop-1' },
    seo_gsc_properties: { id: 'prop-1', site_url: SITE },
  };
  return {
    sb: { from: (table: string) => chain(rows[table] ?? null) },
    registry: { getDataSource: () => new GscDataSource({ config: {}, logger: noopLogger }) },
    credentials: { reader: () => reader },
    usageEvents: store,
  } as never;
}

type ProviderContextReader = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, meta?: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
};

function reader(): ProviderContextReader {
  return {
    get: async (key) => (key === 'google_access_token' ? 'access-token' : key === 'google_refresh_token' ? 'refresh-token' : null),
    set: async () => {},
    delete: async () => {},
  };
}

function response(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('gsc_sync executor usage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits one gsc_request per real request with sourceId = job.id', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => response({ rows: [] })));

    const executor = getExecutor('gsc_sync')!;
    await executor({
      container: container(store, reader()),
      job: { id: JOB_ID, project_id: PROJECT, data_source_id: 'ds-1', created_by: USER, params: {} } as never,
      writer: {
        persistGsc: vi.fn(async () => undefined),
        ingestGscKeywords: vi.fn(async () => undefined),
        persistPages: vi.fn(async () => undefined),
        markDataSourceSynced: vi.fn(async () => undefined),
      } as never,
      report: vi.fn(async () => undefined),
    });

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(9);
    for (const event of events) {
      expect(event).toMatchObject({
        category: 'google',
        provider: 'gsc',
        unit: 'gsc_request',
        quantity: 1,
        success: true,
        sourceId: JOB_ID,
        userId: USER,
      });
    }
  });

  it('deduplicates a re-execution through the ledger idempotency key', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => response({ rows: [] })));

    const run = () =>
      getExecutor('gsc_sync')!({
        container: container(store, reader()),
        job: { id: JOB_ID, project_id: PROJECT, data_source_id: 'ds-1', created_by: USER, params: {} } as never,
        writer: {
          persistGsc: vi.fn(async () => undefined),
          ingestGscKeywords: vi.fn(async () => undefined),
          persistPages: vi.fn(async () => undefined),
          markDataSourceSynced: vi.fn(async () => undefined),
        } as never,
        report: vi.fn(async () => undefined),
      });

    await run();
    await run();

    expect(await store.list({ projectId: PROJECT, limit: 500 })).toHaveLength(9);
  });
});

describe('gsc_sync executor range bypass closure (P11)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function writer() {
    return {
      persistGsc: vi.fn(async () => undefined),
      ingestGscKeywords: vi.fn(async () => undefined),
      persistPages: vi.fn(async () => undefined),
      markDataSourceSynced: vi.fn(async () => undefined),
    } as never;
  }

  function spanDays(range: { startDate: string; endDate: string }): number {
    return (Date.parse(range.endDate) - Date.parse(range.startDate)) / 86_400_000;
  }

  it('clamps an oversized days parameter from the generic /jobs path', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => response({ rows: [] })));

    const out = await getExecutor('gsc_sync')!({
      container: container(store, reader()),
      job: {
        id: JOB_ID,
        project_id: PROJECT,
        data_source_id: 'ds-1',
        created_by: USER,
        params: { endDate: '2026-01-31', days: 100000 },
      } as never,
      writer: writer(),
      report: vi.fn(async () => undefined),
    });

    const range = out.range as { startDate: string; endDate: string };
    expect(range.endDate).toBe('2026-01-31');
    expect(spanDays(range)).toBe(89);
  });

  it('ignores an explicit startDate that would widen the range past the ceiling', async () => {
    const store = new InMemoryUsageEventStore();
    vi.stubGlobal('fetch', vi.fn(async () => response({ rows: [] })));

    const out = await getExecutor('gsc_sync')!({
      container: container(store, reader()),
      job: {
        id: JOB_ID,
        project_id: PROJECT,
        data_source_id: 'ds-1',
        created_by: USER,
        params: { endDate: '2026-01-31', startDate: '1900-01-01' },
      } as never,
      writer: writer(),
      report: vi.fn(async () => undefined),
    });

    const range = out.range as { startDate: string; endDate: string };
    expect(range.endDate).toBe('2026-01-31');
    expect(spanDays(range)).toBe(27);
  });
});
