import { describe, expect, it } from 'vitest';
import { dimensionsForModel, embedderFromConfig } from './embedding.js';

describe('embedderFromConfig', () => {
  it('returns null when no embedding-capable key is configured', () => {
    expect(embedderFromConfig({})).toBeNull();
    expect(embedderFromConfig({ QDRANT_URL: 'http://x' })).toBeNull();
  });

  it('uses an explicit EMBEDDINGS_* endpoint when present', () => {
    const e = embedderFromConfig({ EMBEDDINGS_BASE_URL: 'http://emb', EMBEDDINGS_API_KEY: 'k' });
    expect(e).not.toBeNull();
    expect(e!.dimensions).toBe(1536);
  });

  it('falls back to the OpenAI key with inferred dimensions', () => {
    const small = embedderFromConfig({ OPENAI_API_KEY: 'k' });
    expect(small).not.toBeNull();
    expect(small!.dimensions).toBe(1536);

    const large = embedderFromConfig({
      OPENAI_API_KEY: 'k',
      OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
    });
    expect(large!.dimensions).toBe(3072);
  });

  it('honours an explicit EMBEDDINGS_DIMENSIONS override', () => {
    const e = embedderFromConfig({ EMBEDDINGS_DIMENSIONS: '1024', OPENAI_API_KEY: 'k' });
    expect(e!.dimensions).toBe(1024);
  });
});

describe('dimensionsForModel', () => {
  it('maps known OpenAI models and falls back otherwise', () => {
    expect(dimensionsForModel('text-embedding-3-small')).toBe(1536);
    expect(dimensionsForModel('text-embedding-3-large')).toBe(3072);
    expect(dimensionsForModel('text-embedding-ada-002')).toBe(1536);
    expect(dimensionsForModel('custom-model', 2048)).toBe(2048);
  });
});
