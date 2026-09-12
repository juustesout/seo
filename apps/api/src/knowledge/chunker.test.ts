import { describe, expect, it } from 'vitest';
import { chunkKnowledgeText, CHUNK_OVERLAP, CHUNK_TARGET } from './chunker.js';

describe('chunkKnowledgeText', () => {
  it('returns no chunks for blank input', () => {
    expect(chunkKnowledgeText('')).toEqual([]);
    expect(chunkKnowledgeText('   \n\t ')).toEqual([]);
  });

  it('returns a single chunk when the text fits', () => {
    expect(chunkKnowledgeText('hello world')).toEqual(['hello world']);
  });

  it('collapses whitespace surface before chunking', () => {
    expect(chunkKnowledgeText('a\n\n  b\t c')).toEqual(['a b c']);
  });

  it('is deterministic and stable in order', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    expect(chunkKnowledgeText(text)).toEqual(chunkKnowledgeText(text));
  });

  it('bounds every chunk by the target and never emits empty chunks', () => {
    const text = Array.from({ length: 400 }, (_, i) => `token${i}`).join(' ');
    const chunks = chunkKnowledgeText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_TARGET);
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  it('overlaps adjacent chunks so boundary context is preserved', () => {
    const text = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkKnowledgeText(text);
    expect(chunks.length).toBeGreaterThan(1);
    const overlapProbe = chunks[0].slice(-CHUNK_OVERLAP).split(' ').filter(Boolean).pop()!;
    expect(chunks[1]).toContain(overlapProbe);
  });

  it('respects a custom target for small test corpora', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta';
    const chunks = chunkKnowledgeText(text, 20, 5);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(20);
  });
});
