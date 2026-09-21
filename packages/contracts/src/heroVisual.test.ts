/**
 * Hero visual target resolution tests (R4.3).
 *
 * Pins the deterministic meaning of "hero" in the canonical document: an
 * explicit `hero` container or the heading-delimited page hero. Resolution either
 * returns bounded heading/supporting context or null; it never invents a hero.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalDocument } from './canonical.js';
import { HERO_BLOCK_TYPE, resolveHeroVisual } from './heroVisual.js';
import { IMAGE_INSERTION_HERO_PLACEMENT, IMAGE_INSERTION_HERO_SUPPORTING_MAX_CHARS } from './imageInsertion.js';

function doc(blocks: CanonicalDocument['blocks']): CanonicalDocument {
  return { version: 1, blocks };
}

function target(over: Partial<Parameters<typeof resolveHeroVisual>[1]> = {}) {
  return {
    kind: 'hero' as const,
    heroPath: [0],
    anchorPath: [0],
    nodeType: 'heading',
    placement: IMAGE_INSERTION_HERO_PLACEMENT,
    ...over,
  };
}

const REGION_DOC = doc([
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Solar for every roof' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Clean energy for homes.' }] },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'How it works' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Panels capture sunlight.' }] },
]);

const CONTAINER_DOC = doc([
  { type: 'paragraph', content: [{ type: 'text', text: 'Intro.' }] },
  {
    type: 'hero',
    children: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Storage' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Batteries hold charge.' }] },
    ],
  },
]);

describe('resolveHeroVisual', () => {
  it('resolves a heading-delimited page hero with bounded supporting context', () => {
    const resolved = resolveHeroVisual(REGION_DOC, target());
    expect(resolved).not.toBeNull();
    expect(resolved?.nodeType).toBe('heading');
    expect(resolved?.heading).toBe('Solar for every roof');
    expect(resolved?.supportingText).toContain('Clean energy for homes.');
    expect(resolved?.supportingText).not.toContain('Panels capture sunlight.');
    expect(resolved?.hasImage).toBe(false);
  });

  it('resolves an explicit hero container addressed by its leading heading', () => {
    const resolved = resolveHeroVisual(CONTAINER_DOC, target({ heroPath: [1], anchorPath: [1, 0], nodeType: 'compositionHero' }));
    expect(resolved).not.toBeNull();
    expect(resolved?.nodeType).toBe(HERO_BLOCK_TYPE);
    expect(resolved?.heading).toBe('Storage');
    expect(resolved?.supportingText).toContain('Batteries hold charge.');
  });

  it('reports an existing image in the hero so a duplicate is not added', () => {
    const withImage = doc([
      {
        type: 'hero',
        children: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Storage' }] },
          { type: 'image', attrs: { mediaId: 'm1', src: 'https://x.test/a.png', alt: 'Battery' } },
        ],
      },
    ]);
    const resolved = resolveHeroVisual(withImage, target({ heroPath: [0], anchorPath: [0, 0] }));
    expect(resolved?.hasImage).toBe(true);
  });

  it('returns null for an invalid or mismatched target instead of guessing', () => {
    expect(resolveHeroVisual(REGION_DOC, target({ heroPath: [9], anchorPath: [9] }))).toBeNull();
    expect(resolveHeroVisual(REGION_DOC, target({ heroPath: [1], anchorPath: [1] }))).toBeNull();
    expect(resolveHeroVisual(CONTAINER_DOC, target({ heroPath: [0], anchorPath: [1, 0] }))).toBeNull();
    expect(resolveHeroVisual(CONTAINER_DOC, target({ heroPath: [1], anchorPath: [1, 9] }))).toBeNull();
  });

  it('bounds the derived supporting text', () => {
    const long = doc([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Long' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'word '.repeat(1000) }] },
    ]);
    const resolved = resolveHeroVisual(long, target());
    expect((resolved?.supportingText.length ?? 0) <= IMAGE_INSERTION_HERO_SUPPORTING_MAX_CHARS).toBe(true);
  });
});
