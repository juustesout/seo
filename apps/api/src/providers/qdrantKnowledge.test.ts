import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ProviderContext } from '@seo/contracts';
import { QdrantKnowledgeProvider, deterministicId } from './qdrantKnowledge.js';

const CONTEXT = (projectId: string): ProviderContext => ({
  projectId,
  userId: null,
  config: {},
  credentials: { get: async () => null, set: async () => {}, delete: async () => {} },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});

const CONFIG = {
  QDRANT_URL: 'http://qdrant:6333',
  QDRANT_API_KEY: 'qdrant-key',
  OPENAI_API_KEY: 'sk-test',
  OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeHarness() {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ method, url, body });

    if (url.includes('/embeddings')) {
      const req = body as { input?: string[] };
      const n = Array.isArray(req.input) ? req.input.length : 1;
      return jsonResponse({ data: Array.from({ length: n }, () => ({ embedding: Array(1536).fill(0.01) })) });
    }
    if (url.includes('/points/search')) {
      return jsonResponse({
        result: [
          { id: 'hit1', score: 0.92, payload: { project_id: 'p2', external_id: 'doc-a', kind: 'note', title: 'Note A', url: 'https://a.example', text: 'chunk text A', chunk_index: 0 } },
          { id: 'hit2', score: 0.81, payload: { project_id: 'p2', external_id: 'doc-b', kind: 'page', title: 'Page B', text: 'chunk text B', chunk_index: 1 } },
        ],
      });
    }
    if (url.includes('/points') && (method === 'PUT' || method === 'POST')) {
      return jsonResponse({ result: { status: 'completed' } });
    }
    return jsonResponse({ result: {} });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function provider(config: Record<string, string | undefined> = CONFIG) {
  return new QdrantKnowledgeProvider({ config, logger: { info() {}, warn() {}, error() {}, debug() {} } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QdrantKnowledgeProvider configuration honesty', () => {
  it('refuses to index when Qdrant is not configured', async () => {
    const p = provider({ EMBEDDINGS_API_KEY: 'k' });
    await expect(
      p.index(CONTEXT('p1'), [{ externalId: 'x', kind: 'note', text: 'hello' }]),
    ).rejects.toThrowError(/Qdrant is not configured/);
  });

  it('refuses to index when no embedding provider exists', async () => {
    const p = provider({ QDRANT_URL: 'http://q:6333', QDRANT_API_KEY: 'k' });
    await expect(
      p.index(CONTEXT('p1'), [{ externalId: 'x', kind: 'note', text: 'hello' }]),
    ).rejects.toThrowError(/embedding/i);
  });
});

describe('deterministic chunk ids', () => {
  it('are stable and differ per chunk and source', () => {
    expect(deterministicId('p1', 'doc-1', 0)).toBe(deterministicId('p1', 'doc-1', 0));
    expect(deterministicId('p1', 'doc-1', 0)).not.toBe(deterministicId('p1', 'doc-1', 1));
    expect(deterministicId('p1', 'doc-1', 0)).not.toBe(deterministicId('p2', 'doc-1', 0));
  });
});

describe('indexing (extract -> chunk -> embed -> Qdrant)', () => {
  it('embeds + upserts chunk points with full traceability metadata', async () => {
    const { calls } = makeHarness();
    const p = provider();
    const text = 'A short project note about phase E ingestion.';
    const res = await p.index(CONTEXT('p1'), [
      { externalId: 'source:abc', kind: 'note', title: 'My note', url: 'https://n.example', text },
    ]);

    expect(res.indexed).toBe(1);
    const embeds = calls.filter((c) => c.url.includes('/embeddings'));
    expect(embeds.length).toBeGreaterThan(0);
    expect((embeds[0].body as { model: string }).model).toBe('text-embedding-3-small');

    const upserts = calls.filter((c) => c.method === 'PUT' && c.url.includes('/points?wait=true'));
    expect(upserts).toHaveLength(1);
    const points = (upserts[0].body as { points: Array<Record<string, unknown>> }).points;
    expect(points).toHaveLength(1);
    const payload = points[0].payload as Record<string, unknown>;
    expect(points[0].id).toBe(deterministicId('p1', 'source:abc', 0));
    expect(payload.project_id).toBe('p1');
    expect(payload.external_id).toBe('source:abc');
    expect(payload.source_id).toBe('source:abc');
    expect(payload.kind).toBe('note');
    expect(payload.source_type).toBe('note');
    expect(payload.title).toBe('My note');
    expect(payload.url).toBe('https://n.example');
    expect(payload.text).toBe(text);
    expect(payload.chunk_index).toBe(0);
    expect(payload.chunk_total).toBe(1);
    expect(payload.meta).toEqual({});
  });

  it('splits long text into several deterministic chunks', async () => {
    const { calls } = makeHarness();
    const p = provider();
    const longText = Array.from({ length: 80 }, (_, i) => `paragraph ${i} with enough words to overflow a single 900 char chunk.`).join(' ');
    const res = await p.index(CONTEXT('p1'), [{ externalId: 'source:long', kind: 'note', title: 'Long', text: longText }]);

    const upserts = calls.filter((c) => c.method === 'PUT' && c.url.includes('/points?wait=true'));
    const points = (upserts[upserts.length - 1].body as { points: Array<Record<string, unknown>> }).points;
    expect(points.length).toBeGreaterThan(1);
    expect(res.indexed).toBe(points.length);
    const total = points.length;
    const texts = new Set<string>();
    points.forEach((pt, i) => {
      const payload = pt.payload as Record<string, unknown>;
      expect(payload.chunk_total).toBe(total);
      expect(payload.chunk_index).toBe(i);
      expect(payload.project_id).toBe('p1');
      expect(payload.external_id).toBe('source:long');
      texts.add(String(payload.text));
    });
    expect(texts.size).toBe(total); // no empty / duplicated chunks
  });
});

describe('search (embed -> Qdrant with project filter)', () => {
  it('always filters by project_id and returns mapped hits', async () => {
    const { calls } = makeHarness();
    const p = provider();
    const results = await p.search({ query: 'what is on-page seo', projectId: 'p2', limit: 5 });

    const searchCall = calls.find((c) => c.url.includes('/points/search'));
    expect(searchCall).toBeTruthy();
    const body = searchCall!.body as { filter: { must: Array<Record<string, unknown>> }; limit: number };
    expect(body.filter.must.some((m) => m.key === 'project_id' && (m.match as { value: string }).value === 'p2')).toBe(true);
    expect(body.limit).toBe(5);

    expect(results).toHaveLength(2);
    expect(results[0].payload.title).toBe('Note A');
    expect(results[0].score).toBeCloseTo(0.92);
  });

  it('adds a kind filter when requested', async () => {
    const { calls } = makeHarness();
    const p = provider();
    await p.search({ query: 'q', projectId: 'p9', filter: { kind: 'page' }, limit: 3 });

    const searchCall = calls.find((c) => c.url.includes('/points/search'));
    const body = searchCall!.body as { filter: { must: Array<Record<string, unknown>> } };
    expect(
      body.filter.must.some((m) => m.key === 'kind' && (m.match as { any: string[] }).any.includes('page')),
    ).toBe(true);
  });
});

describe('delete', () => {
  it('removes only the matching project + external_id vectors', async () => {
    const { calls } = makeHarness();
    const p = provider();
    await p.delete(CONTEXT('p1'), 'doc-1');

    const del = calls.find((c) => c.method === 'POST' && c.url.includes('/points/delete'));
    expect(del).toBeTruthy();
    const body = del!.body as { filter: { must: Array<Record<string, unknown>> } };
    expect(
      body.filter.must.some((m) => m.key === 'project_id' && (m.match as { value: string }).value === 'p1'),
    ).toBe(true);
    expect(
      body.filter.must.some((m) => m.key === 'external_id' && (m.match as { value: string }).value === 'doc-1'),
    ).toBe(true);
  });
});
