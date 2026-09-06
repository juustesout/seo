import { describe, expect, it } from 'vitest';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import {
  buildSourceDocument,
  KnowledgeService,
  KNOWLEDGE_MAX_CHARS,
  mapSourceRow,
  sourceExternalId,
} from './knowledgeService.js';

const ROW = {
  id: '00000000-0000-0000-0000-0000000000aa',
  project_id: '00000000-0000-0000-0000-0000000000bb',
  source_type: 'note',
  name: 'My note',
  url: 'https://notes.example/x',
  content_text: 'Some\n\n  content  here.',
};

function configuredContainer(): ServiceContainer {
  return {
    config: {
      env: { QDRANT_URL: 'http://qdrant:6333', QDRANT_API_KEY: 'k', OPENAI_API_KEY: 'sk' },
    },
    registry: { getKnowledge: () => ({ id: 'qdrant' }) },
    sb: {},
    jobStore: {},
  } as unknown as ServiceContainer;
}

function bareContainer(): ServiceContainer {
  return { config: { env: {} }, registry: { getKnowledge: () => undefined }, sb: {}, jobStore: {} } as unknown as ServiceContainer;
}

describe('knowledge source external ids + documents', () => {
  it('external ids are stable per source id', () => {
    expect(sourceExternalId('abc')).toBe('source:abc');
    expect(sourceExternalId('abc')).not.toBe(sourceExternalId('abd'));
  });

  it('builds a provider document with text, title, url and metadata', () => {
    const doc = buildSourceDocument(ROW);
    expect(doc).not.toBeNull();
    expect(doc!.externalId).toBe('source:00000000-0000-0000-0000-0000000000aa');
    expect(doc!.kind).toBe('note');
    expect(doc!.title).toBe('My note');
    expect(doc!.url).toBe('https://notes.example/x');
    expect(doc!.text).toBe('Some content here.');
    expect(doc!.meta).toEqual({ source: 'knowledge_source', source_type: 'note' });
  });

  it('falls back to an addressable stub for a URL-only source', () => {
    const doc = buildSourceDocument({ ...ROW, content_text: null });
    expect(doc).not.toBeNull();
    expect(doc!.text).toContain('Reference URL:');
  });

  it('returns null when there is nothing to index', () => {
    expect(buildSourceDocument({ ...ROW, name: '', content_text: '   ' })).toBeNull();
  });

  it('maps rows to the list DTO without leaking content_text', () => {
    const dto = mapSourceRow({ ...ROW, status: 'indexed', chunk_count: 3, error: null, last_indexed_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
    expect(dto.status).toBe('indexed');
    expect(dto.chunk_count).toBe(3);
    expect(dto.error).toBeNull();
    expect(dto.name).toBe('My note');
    expect('content_text' in dto).toBe(false);
  });
});

describe('KnowledgeService gates + validation', () => {
  it('reports not configured when Qdrant env is missing', () => {
    const svc = new KnowledgeService(bareContainer());
    expect(svc.configuredReason()).toContain('QDRANT_URL');
  });

  it('reports not configured when no embedding key exists', () => {
    const svc = new KnowledgeService({
      config: { env: { QDRANT_URL: 'http://qdrant:6333', QDRANT_API_KEY: 'k' } },
      registry: { getKnowledge: () => ({ id: 'qdrant' }) },
    } as unknown as ServiceContainer);
    expect(svc.configuredReason()).toContain('EMBEDDINGS_API_KEY');
  });

  it('returns null reason when fully configured', () => {
    expect(new KnowledgeService(configuredContainer()).configuredReason()).toBeNull();
  });

  it('refuses to create a source when knowledge is not configured', async () => {
    const svc = new KnowledgeService(bareContainer());
    await expect(svc.createSource('p1', 'u1', { name: 'Note' })).rejects.toThrowError(/not configured/);
  });

  it('validates input before touching storage', async () => {
    const svc = new KnowledgeService(configuredContainer());
    await expect(svc.createSource('p1', 'u1', { name: '' })).rejects.toMatchObject({
      status: 400,
      message: 'Give the source a name.',
    });
    await expect(svc.createSource('p1', 'u1', { name: 'Empty' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Add text or a URL'),
    });
    await expect(
      svc.createSource('p1', 'u1', { name: 'Huge', text: 'x'.repeat(KNOWLEDGE_MAX_CHARS + 1) }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('too large') });
  });
});
