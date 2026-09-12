/**
 * KB9 knowledge discovery service: session lifecycle, candidate policy and
 * apply semantics. A compact Supabase-like fake and a fake discovery provider
 * keep the tests deterministic and network-free while exercising the real
 * service code (injection, scope, de-duplication, idempotent apply).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDiscoveryProvider, KnowledgeProvider } from '@seo/contracts';
import type { ServiceContainer } from '../context.js';
import { KnowledgeService } from './knowledgeService.js';

afterEach(() => vi.restoreAllMocks());

const PROJECT = '00000000-0000-0000-0000-0000000000bb';
const SESSION = '00000000-0000-0000-0000-0000000000cc';
const COLLECTION = '00000000-0000-0000-0000-0000000000dd';
const EXISTING = '00000000-0000-0000-0000-0000000000ee';
const ENV = { QDRANT_URL: 'http://q', QDRANT_API_KEY: 'k', OPENAI_API_KEY: 'sk' };

type Row = Record<string, unknown>;

function makeSb(seed: { sessions?: Row[]; sources?: Row[]; collections?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    seo_knowledge_discovery_sessions: (seed.sessions ?? []).map((r) => ({ ...r })),
    seo_knowledge_sources: (seed.sources ?? []).map((r) => ({ ...r })),
    seo_knowledge_collections: (seed.collections ?? []).map((r) => ({ ...r })),
  };
  let seq = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const sb = {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let patch: Row | null = null;
      let inserted: Row | null = null;
      let mode: 'many' | 'single' | 'maybeSingle' = 'many';
      const matches = () => rows.filter((r) => filters.every((f) => f(r)));
      const exec = async () => {
        if (op === 'insert') {
          const created = { id: uuid(), created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...inserted };
          rows.push(created);
          return { data: mode === 'many' ? [created] : created, error: null };
        }
        if (op === 'update') {
          const matched = matches();
          for (const r of matched) Object.assign(r, patch);
          return { data: matched.map((r) => ({ id: r.id })), error: null };
        }
        if (op === 'delete') {
          for (const r of matches()) rows.splice(rows.indexOf(r), 1);
          return { data: null, error: null };
        }
        const out = matches();
        if (mode === 'single' || mode === 'maybeSingle') return { data: out[0] ?? null, error: null };
        return { data: out, error: null, count: out.length };
      };
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.insert = (row: Row) => {
        op = 'insert';
        inserted = row;
        return q;
      };
      q.update = (p: Row) => {
        op = 'update';
        patch = p;
        return q;
      };
      q.delete = () => {
        op = 'delete';
        return q;
      };
      q.eq = (col: string, value: unknown) => {
        filters.push((r) => r[col] === value);
        return q;
      };
      q.neq = (col: string, value: unknown) => {
        filters.push((r) => r[col] !== value);
        return q;
      };
      q.in = (col: string, values: unknown[]) => {
        filters.push((r) => (values as unknown[]).includes(r[col]));
        return q;
      };
      q.order = () => q;
      q.limit = () => q;
      q.range = () => q;
      q.single = () => {
        mode = 'single';
        return q;
      };
      q.maybeSingle = () => {
        mode = 'maybeSingle';
        return q;
      };
      q.then = (resolve: (value: unknown) => unknown) => exec().then(resolve);
      return q;
    },
  };
  return { sb: sb as unknown as ServiceContainer['sb'], tables };
}

const fakeKnowledgeProvider = { id: 'qdrant', name: 'Qdrant' } as unknown as KnowledgeProvider;

function fakeDiscoveryProvider(
  links: Array<{ url: string; title?: string; depth: number; discoveredFrom?: string }>,
): KnowledgeDiscoveryProvider & { discover: ReturnType<typeof vi.fn> } {
  return {
    id: 'jina',
    name: 'Jina Reader',
    isConfigured: () => true,
    discover: vi.fn(async () => ({ links, seedTitle: 'Seed title' })),
  } as unknown as KnowledgeDiscoveryProvider & { discover: ReturnType<typeof vi.fn> };
}

function container(
  sb: ServiceContainer['sb'],
  provider: KnowledgeDiscoveryProvider | null,
  enqueue = vi.fn(async () => ({ id: 'job-1' })),
): ServiceContainer {
  return {
    config: { env: ENV },
    registry: { getKnowledge: (id: string) => (id === 'qdrant' ? fakeKnowledgeProvider : undefined) },
    sb,
    jobStore: { enqueue },
    knowledgeFetcher: {} as never,
    knowledgeDiscoveryProvider: provider,
  } as unknown as ServiceContainer;
}

function session(overrides: Row = {}): Row {
  return {
    id: SESSION,
    project_id: PROJECT,
    seed_url: 'https://example.com/',
    normalized_seed_url: 'https://example.com/',
    collection_id: null,
    status: 'queued',
    scope: 'same_host',
    max_urls: 25,
    max_depth: 1,
    request_json: {},
    result_json: null,
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const candidate = (overrides: Row = {}): Row => ({
  url: 'https://example.com/a',
  normalizedUrl: 'https://example.com/a',
  title: 'A',
  depth: 1,
  discoveredFrom: 'https://example.com/',
  eligible: true,
  reason: null,
  alreadyExists: false,
  existingSourceId: null,
  ...overrides,
});

describe('KnowledgeService.startDiscovery (KB9)', () => {
  it('rejects an SSRF/unsupported seed before creating a session', async () => {
    const { sb, tables } = makeSb();
    const svc = new KnowledgeService(container(sb, fakeDiscoveryProvider([])));
    await expect(svc.startDiscovery(PROJECT, 'user', { seedUrl: 'http://127.0.0.1/x' })).rejects.toMatchObject({
      code: 'knowledge_invalid_url',
    });
    expect(tables.seo_knowledge_discovery_sessions).toHaveLength(0);
  });

  it('refuses to start when no discovery provider is configured', async () => {
    const { sb } = makeSb();
    const svc = new KnowledgeService(container(sb, null));
    await expect(svc.startDiscovery(PROJECT, 'user', { seedUrl: 'https://example.com' })).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('persists a bounded queued session and enqueues the discovery job', async () => {
    const { sb, tables } = makeSb();
    const enqueue = vi.fn(async () => ({ id: 'job-1' }));
    const svc = new KnowledgeService(container(sb, fakeDiscoveryProvider([]), enqueue));
    const result = await svc.startDiscovery(PROJECT, 'user', { seedUrl: 'https://Example.com/a/', maxDepth: 9, maxUrls: 9999, scope: 'same_domain' });

    expect(result.session.status).toBe('queued');
    expect(result.session.scope).toBe('same_domain');
    expect(result.session.maxDepth).toBe(3);
    expect(result.session.maxUrls).toBe(100);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ job_type: 'knowledge_discovery', params: { session_id: expect.any(String) } }),
    );
    expect(tables.seo_knowledge_discovery_sessions).toHaveLength(1);
  });
});

describe('KnowledgeService.runDiscovery (KB9)', () => {
  it('builds ordered candidates and marks scope/duplicate reasons', async () => {
    const { sb } = makeSb({
      sessions: [session()],
      sources: [{ id: EXISTING, project_id: PROJECT, source_type: 'url', url: 'https://example.com/dupe', status: 'ready' }],
    });
    const provider = fakeDiscoveryProvider([
      { url: 'https://example.com/b', depth: 1 },
      { url: 'https://example.com/dupe', depth: 1 },
      { url: 'https://other.com/x', depth: 1 },
      { url: 'https://example.com/a', depth: 1, title: 'A' },
    ]);
    const svc = new KnowledgeService(container(sb, provider));
    const summary = await svc.runDiscovery(PROJECT, SESSION, vi.fn(async () => undefined));

    expect(summary).toMatchObject({ candidates: 4, eligible: 2 });
    const detail = await svc.getDiscoverySession(PROJECT, SESSION);
    expect(detail.status).toBe('ready');
    const byUrl = new Map(detail.candidates.map((c) => [c.normalizedUrl, c]));
    expect(byUrl.get('https://example.com/dupe')).toMatchObject({ eligible: false, reason: 'duplicate', alreadyExists: true, existingSourceId: EXISTING });
    expect(byUrl.get('https://other.com/x')).toMatchObject({ eligible: false, reason: 'out_of_scope' });
    // Deterministic ordering: all depth 1, so discovery order is preserved.
    expect(detail.candidates.map((c) => c.normalizedUrl)[0]).toBe('https://example.com/b');
  });

  it('marks an unsupported discovered URL as ineligible rather than dropping the session', async () => {
    const { sb } = makeSb({ sessions: [session()] });
    const provider = fakeDiscoveryProvider([{ url: 'http://localhost/secret', depth: 1 }]);
    const svc = new KnowledgeService(container(sb, provider));
    await svc.runDiscovery(PROJECT, SESSION);
    const detail = await svc.getDiscoverySession(PROJECT, SESSION);
    expect(detail.candidates[0]).toMatchObject({ eligible: false, reason: 'url_not_allowed' });
  });

  it('fails the session honestly when discovery throws', async () => {
    const { sb } = makeSb({ sessions: [session()] });
    const provider = fakeDiscoveryProvider([]);
    provider.discover.mockRejectedValueOnce(new Error('boom'));
    const svc = new KnowledgeService(container(sb, provider));
    await expect(svc.runDiscovery(PROJECT, SESSION)).rejects.toThrow('boom');
    const detail = await svc.getDiscoverySession(PROJECT, SESSION);
    expect(detail.status).toBe('failed');
    expect(detail.errorCode).toBe('knowledge_fetch_provider_error');
  });
});

describe('KnowledgeService.applyDiscovery (KB9)', () => {
  it('creates eligible sources, skips duplicates and reports honest counts', async () => {
    const { sb, tables } = makeSb({
      sessions: [
        session({
          status: 'ready',
          result_json: {
            candidates: [
              candidate({ url: 'https://example.com/a', normalizedUrl: 'https://example.com/a' }),
              candidate({ url: 'https://example.com/dupe', normalizedUrl: 'https://example.com/dupe', eligible: false, reason: 'duplicate', alreadyExists: true, existingSourceId: EXISTING }),
              candidate({ url: 'https://other.com/x', normalizedUrl: 'https://other.com/x', eligible: false, reason: 'out_of_scope' }),
            ],
          },
        }),
      ],
    });
    const enqueueIngest = vi.spyOn(KnowledgeService.prototype, 'enqueueIngest').mockResolvedValue({ id: 'job-2' } as never);
    const svc = new KnowledgeService(container(sb, fakeDiscoveryProvider([])));

    const result = await svc.applyDiscovery(PROJECT, 'user', SESSION, [
      'https://example.com/a',
      'https://example.com/dupe',
      'https://other.com/x',
      'https://unknown.com/injected',
    ]);

    expect(result).toMatchObject({ created: 1, alreadyExists: 1, queued: 1, rejected: 2 });
    const created = (tables.seo_knowledge_sources ?? []).find((r) => r.url === 'https://example.com/a');
    expect(created).toMatchObject({ project_id: PROJECT, source_type: 'url', status: 'draft' });
    expect(enqueueIngest).toHaveBeenCalledTimes(1);
    expect((tables.seo_knowledge_discovery_sessions[0]! as Row).status).toBe('applied');
  });

  it('re-running apply never duplicates an already-created source', async () => {
    const { sb, tables } = makeSb({
      sessions: [session({ status: 'ready', result_json: { candidates: [candidate()] } })],
    });
    vi.spyOn(KnowledgeService.prototype, 'enqueueIngest').mockResolvedValue({ id: 'job-2' } as never);
    const svc = new KnowledgeService(container(sb, fakeDiscoveryProvider([])));

    const first = await svc.applyDiscovery(PROJECT, 'user', SESSION, ['https://example.com/a']);
    const second = await svc.applyDiscovery(PROJECT, 'user', SESSION, ['https://example.com/a']);

    expect(first.created).toBe(1);
    expect(second).toMatchObject({ created: 0, alreadyExists: 1 });
    expect(tables.seo_knowledge_sources.filter((r) => r.url === 'https://example.com/a')).toHaveLength(1);
  });

  it('refuses to apply while discovery is still running', async () => {
    const { sb } = makeSb({ sessions: [session({ status: 'processing' })] });
    const svc = new KnowledgeService(container(sb, fakeDiscoveryProvider([])));
    await expect(svc.applyDiscovery(PROJECT, 'user', SESSION, ['https://example.com/a'])).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
