/**
 * Production writer context adapters tests: the container-built adapters
 * reuse the existing project-scoped services, scope every read to the exact
 * projectId they are handed, and report source state honestly (not configured
 * when env/integration is missing, empty/no_data when nothing matched,
 * available/configured only with real rows). All reads are faked; nothing
 * touches Qdrant, a database or the network.
 */

import { describe, expect, it } from 'vitest';
import type { ServiceContainer } from '../../context.js';
import { createWriterContextDependencies } from './contextDependencies.js';
import type { WriterContextInput } from './context.js';

const projectId = 'c00162dd-d23e-4904-85ca-76cccc6d8c90';
const baseInput: WriterContextInput = { projectId, topic: 'SEO content ops', targetKeyword: 'seo content ops' };

type Row = Record<string, unknown>;
type FakeCall = { table: string; method: string; field?: string; value?: unknown };

interface FakeSb {
  from(table: string): unknown;
}

/** Minimal thenable Supabase fake that returns canned rows per table and
 *  records eq() filters so tests can assert project scoping. */
function fakeSupabase(stores: Record<string, Row[]>) {
  const calls: FakeCall[] = [];
  const rowsFor = (table: string): Row[] => stores[table] ?? [];
  const from = (table: string) => {
    const rows = rowsFor(table);
    const builder = {
      select() {
        return builder;
      },
      eq(field: string, value: unknown) {
        calls.push({ table, method: 'eq', field, value });
        return builder;
      },
      ilike(field: string, value: unknown) {
        calls.push({ table, method: 'ilike', field, value });
        return builder;
      },
      is(field: string, value: unknown) {
        calls.push({ table, method: 'is', field, value });
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return builder;
  };
  const sb = { from } as unknown as FakeSb;
  return { sb, calls };
}

function container(
  sb: ReturnType<typeof fakeSupabase>['sb'],
  env: Record<string, string>,
  registry: unknown,
): ServiceContainer {
  return {
    config: { env },
    sb,
    registry,
  } as unknown as ServiceContainer;
}

/** eq('project_id', ...) values recorded per table, proving scope enforcement. */
function projectScopeCalls(calls: FakeCall[], table: string): unknown[] {
  return calls.filter((c) => c.table === table && c.method === 'eq' && c.field === 'project_id').map((c) => c.value);
}

const configEnv = { QDRANT_URL: 'http://qdrant:6333', QDRANT_API_KEY: 'k', EMBEDDINGS_API_KEY: 'e', OPENAI_API_KEY: 'o' };

describe('writer context dependencies (production adapters)', () => {
  it('existing content maps light metadata rows and scopes to the project', async () => {
    const { sb, calls } = fakeSupabase({
      seo_content: [
        { id: 'c1', title: 'Our post', slug: 'our-post', target_keyword: 'seo content ops', status: 'published' },
      ],
    });
    const deps = createWriterContextDependencies(container(sb, configEnv, {}));
    const result = await deps.getExistingContent(baseInput);

    expect(result.status).toBe('available');
    expect(result.items).toEqual([
      { id: 'c1', title: 'Our post', slug: 'our-post', targetKeyword: 'seo content ops', status: 'published' },
    ]);
    expect(projectScopeCalls(calls, 'seo_content')).toEqual([projectId]);
  });

  it('existing content reports empty when no rows match', async () => {
    const { sb } = fakeSupabase({ seo_content: [] });
    const deps = createWriterContextDependencies(container(sb, configEnv, {}));
    const result = await deps.getExistingContent(baseInput);

    expect(result.status).toBe('empty');
    expect(result.items).toEqual([]);
  });

  it('knowledge reports not_configured when Qdrant env is missing and never searches', async () => {
    const searched: unknown[] = [];
    const registry = { getKnowledge: () => ({ search: async (opts: unknown) => (searched.push(opts), []) }) };
    const { sb } = fakeSupabase({});
    const deps = createWriterContextDependencies(container(sb, {}, registry));
    const result = await deps.getKnowledge(baseInput);

    expect(result.status).toBe('not_configured');
    expect(result.chunks).toEqual([]);
    expect(searched).toHaveLength(0);
  });

  it('knowledge maps attributed search hits to chunks and drops unattributed ones', async () => {
    let searched = 0;
    const registry = {
      getKnowledge: () => ({
        id: 'qdrant',
        search: async () => {
          searched += 1;
          return [
            { id: 'point-1', score: 0.9, payload: { source_id: 'src-1', title: 'Guide', text: 'body text' } },
            { id: 'point-2', score: 0.7, payload: { source_id: null, title: '', text: 'no title chunk' } },
          ];
        },
      }),
    };
    const { sb } = fakeSupabase({});
    const deps = createWriterContextDependencies(container(sb, configEnv, registry));
    const result = await deps.getKnowledge(baseInput);

    expect(searched).toBe(1);
    expect(result.status).toBe('available');
    // The canonical boundary drops any hit without a real source identity, so
    // the internal point id can never become a writer-visible sourceId.
    expect(result.chunks).toEqual([{ sourceId: 'src-1', title: 'Guide', text: 'body text' }]);
  });

  it('knowledge reports empty when search returns no usable chunks', async () => {
    const registry = { getKnowledge: () => ({ search: async () => [] }) };
    const { sb } = fakeSupabase({});
    const deps = createWriterContextDependencies(container(sb, configEnv, registry));
    const result = await deps.getKnowledge(baseInput);

    expect(result.status).toBe('empty');
    expect(result.chunks).toEqual([]);
  });

  it('intelligence reports not_configured when DataForSEO is not connected', async () => {
    const { sb, calls } = fakeSupabase({ seo_integrations: [], seo_projects: [], seo_keywords: [] });
    const deps = createWriterContextDependencies(container(sb, configEnv, {}));
    const result = await deps.getIntelligence(baseInput);

    expect(result.status).toBe('not_configured');
    expect(result.keywords).toEqual([]);
    expect(projectScopeCalls(calls, 'seo_keywords')).toEqual([]);
  });

  it('intelligence reports configured only with measured evidence rows, project-scoped', async () => {
    const { sb, calls } = fakeSupabase({
      seo_integrations: [{ provider_type: 'dataforseo', status: 'connected' }],
      seo_projects: [{ account_id: 'acct-1' }],
      seo_keywords: [
        { keyword: 'seo content ops', volume: 1200, difficulty: 42, cpc: 3.1, provider: 'dataforseo', last_seen_at: '2026-01-01' },
        { keyword: 'SEO CONTENT OPS', volume: null, difficulty: null, cpc: null, provider: 'manual' },
      ],
    });
    const deps = createWriterContextDependencies(container(sb, configEnv, {}));
    const result = await deps.getIntelligence(baseInput);

    expect(result.status).toBe('configured');
    expect(result.keywords).toHaveLength(1);
    expect(result.keywords[0]).toMatchObject({ keyword: 'seo content ops', volume: 1200 });
    expect(projectScopeCalls(calls, 'seo_keywords')).toEqual([projectId]);
  });

  it('intelligence reports no_data when connected but nothing measured is tracked', async () => {
    const { sb } = fakeSupabase({
      seo_integrations: [{ provider_type: 'dataforseo', status: 'connected' }],
      seo_projects: [{ account_id: 'acct-1' }],
      seo_keywords: [],
    });
    const deps = createWriterContextDependencies(container(sb, configEnv, {}));
    const result = await deps.getIntelligence(baseInput);

    expect(result.status).toBe('no_data');
    expect(result.keywords).toEqual([]);
  });
});
