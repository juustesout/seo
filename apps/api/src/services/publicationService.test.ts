import { describe, expect, it } from 'vitest';
import { PublicationService } from './publicationService.js';
import { ApiError } from '../apiErrors.js';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

// ---------------------------------------------------------------------------
// Supabase-like client fake: chainable read filters with PostgREST-ish order +
// range semantics for the publication list query, plus batched id lookups for
// the enrichment step. Read-only surface is all PublicationService uses.
// ---------------------------------------------------------------------------

type Filter = { op: 'eq' | 'in'; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const got = row[f.col];
    if (f.op === 'eq') return got === f.val;
    if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(got);
    return true;
  });
}

function descNullable(ascending: boolean): (a: unknown, b: unknown) => number {
  const rank = (v: unknown): number => (v == null ? -Infinity : Date.parse(String(v)));
  return (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    // Both null sort as equal regardless of direction (SQL nulls last on desc).
    if (ra === -Infinity && rb === -Infinity) return 0;
    if (ascending) return ra === rb ? 0 : ra < rb ? -1 : 1;
    return ra === rb ? 0 : ra > rb ? -1 : 1;
  };
}

function fakeSb(stores: Store) {
  return {
    from: (table: string) => {
      const state: { filters: Filter[]; single: boolean; range: [number, number] | null } = {
        filters: [],
        single: false,
        range: null,
      };
      const compute = () => {
        const rows = stores[table] ?? [];
        const filtered = rows.filter((r) => matches(r, state.filters));
        if (state.single) return { data: filtered[0] ?? null, error: null };
        const sorted = [...filtered].sort(
          (a, b) =>
            descNullable(false)(a.published_at, b.published_at) ||
            descNullable(false)(a.created_at, b.created_at),
        );
        const data = state.range ? sorted.slice(state.range[0], state.range[1] + 1) : sorted;
        return { data, error: null };
      };
      const b = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          state.filters.push({ op: 'eq', col, val });
          return b;
        },
        in: (col: string, vals: unknown[]) => {
          state.filters.push({ op: 'in', col, val: vals });
          return b;
        },
        order: () => b,
        range: (from: number, to: number) => {
          state.range = [from, to];
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
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function publicationRow(overrides: Row = {}): Row {
  return {
    id: 'pub-1',
    project_id: 'p1',
    content_id: 'c1',
    publisher_id: 'pb1',
    schedule_id: null,
    status: 'published',
    remote_id: null,
    target_url: 'https://example.com/hello',
    error: null,
    scheduled_for: null,
    published_at: '2025-01-02T03:04:05.000Z',
    title: 'Snapshot title',
    // Dangerous columns that must never reach a DTO:
    content: '<p>full article body</p>',
    slug: 'secret-slug',
    excerpt: 'secret excerpt',
    created_by: 'u-secret',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-02T03:04:05.000Z',
    ...overrides,
  };
}

function storesWith(publications: Row[] = [], content: Row[] = [], publishers: Row[] = []): Store {
  return {
    seo_publications: publications,
    seo_content: content,
    seo_publishers: publishers,
  };
}

function svcOf(stores: Store): PublicationService {
  return new PublicationService(fakeSb(stores) as never);
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

const pubColumns = [
  'id',
  'project_id',
  'content_id',
  'content_title',
  'publisher_id',
  'publisher_name',
  'schedule_id',
  'status',
  'remote_id',
  'target_url',
  'scheduled_for',
  'published_at',
  'error',
  'created_at',
  'updated_at',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PublicationService.list', () => {
  it('returns only this project rows, enriched with content title + publisher name, no secrets/bodies', async () => {
    const stores = storesWith(
      [
        publicationRow({ id: 'pub-own', content_id: 'c1' }),
        publicationRow({ id: 'pub-other', project_id: 'p2', content_id: 'c2', publisher_id: 'pb2' }),
      ],
      [
        { id: 'c1', project_id: 'p1', title: 'H3 landing page' },
        { id: 'c2', project_id: 'p2', title: 'Other project article' },
      ],
      [
        { id: 'pb1', project_id: 'p1', name: 'WordPress live' },
        { id: 'pb2', project_id: 'p2', name: 'Other publisher' },
      ],
    );
    const svc = svcOf(stores);

    const rows = await svc.list('p1', { limit: 50, offset: 0 });

    expect(rows.map((r) => r.id)).toEqual(['pub-own']);
    expect(rows[0]).toMatchObject({
      project_id: 'p1',
      content_id: 'c1',
      content_title: 'H3 landing page',
      publisher_id: 'pb1',
      publisher_name: 'WordPress live',
      status: 'published',
      target_url: 'https://example.com/hello',
      published_at: '2025-01-02T03:04:05.000Z',
      created_at: '2025-01-01T00:00:00.000Z',
    });
  });

  it('never leaks article body, slug, excerpt or creator columns in DTOs', async () => {
    const stores = storesWith([publicationRow()]);
    const svc = svcOf(stores);

    const rows = await svc.list('p1', { limit: 50, offset: 0 });

    expect(Object.keys(rows[0]).sort()).toEqual([...pubColumns].sort());
    for (const secret of ['content', 'slug', 'excerpt', 'created_by', 'config', 'credentials']) {
      expect(rows[0]).not.toHaveProperty(secret);
    }
    expect(rows[0].content_title).toBe('Snapshot title');
  });

  it('filters by content_id, publisher_id, status and schedule_id', async () => {
    const stores = storesWith([
      publicationRow({ id: 'a', status: 'published', schedule_id: null }),
      publicationRow({ id: 'b', content_id: 'c-x', status: 'failed', schedule_id: 's-9' }),
      publicationRow({ id: 'c', status: 'scheduled', schedule_id: 's-9', published_at: null, scheduled_for: '2026-01-01T00:00:00.000Z' }),
    ]);
    const svc = svcOf(stores);

    expect((await svc.list('p1', { content_id: 'c-x', limit: 50, offset: 0 })).map((r) => r.id)).toEqual(['b']);
    expect((await svc.list('p1', { status: 'scheduled', limit: 50, offset: 0 })).map((r) => r.id)).toEqual(['c']);
    expect((await svc.list('p1', { schedule_id: 's-9', limit: 50, offset: 0 })).map((r) => r.id)).toEqual(['b', 'c']);
    expect(
      (await svc.list('p1', { status: 'failed', schedule_id: 's-9', content_id: 'c-x', limit: 50, offset: 0 })).map((r) => r.id),
    ).toEqual(['b']);
    expect((await svc.list('p1', { status: 'failed', content_id: 'c1', limit: 50, offset: 0 })).map((r) => r.id)).toEqual([]);
  });

  it('orders by published_at desc (nulls last) then created_at desc and honors limit/offset', async () => {
    const stores = storesWith([
      publicationRow({ id: 'old', published_at: '2025-01-01T00:00:00.000Z', created_at: '2025-01-01T00:00:00.000Z' }),
      publicationRow({ id: 'new', published_at: '2025-03-01T00:00:00.000Z', created_at: '2025-03-01T00:00:00.000Z' }),
      publicationRow({ id: 'planned', published_at: null, status: 'scheduled', created_at: '2025-05-01T00:00:00.000Z' }),
      publicationRow({ id: 'mid', published_at: '2025-02-01T00:00:00.000Z', created_at: '2025-02-01T00:00:00.000Z' }),
    ]);
    const svc = svcOf(stores);

    const page1 = await svc.list('p1', { limit: 2, offset: 0 });
    const page2 = await svc.list('p1', { limit: 2, offset: 2 });
    expect(page1.map((r) => r.id)).toEqual(['new', 'mid']);
    expect(page2.map((r) => r.id)).toEqual(['old', 'planned']);
    expect(page1.length).toBeLessThanOrEqual(2);
  });

  it('marks schedule-linked publications as scheduled via schedule_id and plain rows as null', async () => {
    const stores = storesWith([
      publicationRow({ id: 'direct', schedule_id: null }),
      publicationRow({ id: 'from-schedule', schedule_id: 'sched-1' }),
    ]);
    const svc = svcOf(stores);

    const rows = await svc.list('p1', { limit: 50, offset: 0 });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.direct.schedule_id).toBeNull();
    expect(byId['from-schedule'].schedule_id).toBe('sched-1');
  });

  it('falls back to the stored title snapshot when content no longer resolves', async () => {
    const stores = storesWith([
      publicationRow({ id: 'orphan', content_id: null, title: 'Manual direct post' }),
    ]);
    const svc = svcOf(stores);

    const rows = await svc.list('p1', { limit: 50, offset: 0 });
    expect(rows[0].content_id).toBeNull();
    expect(rows[0].content_title).toBe('Manual direct post');
  });

  it('coerces stored errors to a safe short string message', async () => {
    const stores = storesWith([
      publicationRow({ id: 'oops', status: 'failed', error: { message: 'publisher returned 401', stack: 'at hidden' } }),
      publicationRow({ id: 'strerr', status: 'failed', error: 'plain boom' }),
      publicationRow({ id: 'objerr', status: 'failed', error: { error: 'kaboom', code: 123 } }),
      publicationRow({ id: 'fine', error: null }),
    ]);
    const svc = svcOf(stores);

    const rows = await svc.list('p1', { limit: 50, offset: 0 });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.oops.error).toBe('publisher returned 401');
    expect(byId.strerr.error).toBe('plain boom');
    expect(byId.objerr.error).toBe('kaboom');
    expect(byId.fine.error).toBeNull();
  });

  it('keeps nulls for names/titles it cannot resolve without inventing data', async () => {
    const stores = storesWith(
      [publicationRow({ id: 'ghost', content_id: 'gone', publisher_id: 'ghost-pub' })],
      [],
      [],
    );
    const svc = svcOf(stores);

    const rows = await svc.list('p1', { limit: 50, offset: 0 });
    expect(rows[0].content_title).toBe('Snapshot title'); // snapshot fallback is honest metadata
    expect(rows[0].publisher_name).toBeNull();
  });
});

describe('PublicationService.get', () => {
  it('returns the safe DTO for a row in the project', async () => {
    const stores = storesWith(
      [publicationRow({ id: 'detail-1', remote_id: 'wp-42', target_url: 'https://example.com/p/42' })],
      [{ id: 'c1', project_id: 'p1', title: 'H3 landing page' }],
      [{ id: 'pb1', project_id: 'p1', name: 'WordPress live' }],
    );
    const svc = svcOf(stores);

    const dto = await svc.get('p1', 'detail-1');

    expect(dto).toMatchObject({
      id: 'detail-1',
      content_title: 'H3 landing page',
      publisher_name: 'WordPress live',
      remote_id: 'wp-42',
      target_url: 'https://example.com/p/42',
    });
    expect(dto).not.toHaveProperty('content');
  });

  it('cannot read a publication from another project', async () => {
    const stores = storesWith([publicationRow({ id: 'p2-row', project_id: 'p2' })]);
    const svc = svcOf(stores);

    await expectErrorCode(svc.get('p1', 'p2-row'), 'not_found');
  });

  it('cannot read a publication id that does not exist', async () => {
    const svc = svcOf(storesWith([]));
    await expectErrorCode(svc.get('p1', 'missing'), 'not_found');
  });
});
