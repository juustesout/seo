/**
 * Section visual target resolution tests (R4.2).
 *
 * Pins the deterministic meaning of "section" in the canonical document: an
 * explicit `section` container or a heading-delimited region. Resolution either
 * returns bounded heading/body context or null; it never invents a section.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalDocument } from './canonical.js';
import { resolveSectionVisual, SECTION_VISUAL_MAX_BODY_CHARS } from './sectionVisual.js';

function doc(blocks: CanonicalDocument['blocks']): CanonicalDocument {
  return { version: 1, blocks };
}

const REGION_DOC = doc([
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Solar energy' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Solar panels store energy.' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Battery storage holds charge.' }] },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Wind power' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Turbines capture wind.' }] },
]);

const CONTAINER_DOC = doc([
  { type: 'paragraph', content: [{ type: 'text', text: 'Intro.' }] },
  {
    type: 'section',
    children: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Storage' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Batteries hold charge.' }] },
    ],
  },
]);

describe('resolveSectionVisual', () => {
  it('resolves a heading-delimited region with bounded body context', () => {
    const resolved = resolveSectionVisual(REGION_DOC, { kind: 'section', sectionPath: [0], anchorPath: [0], heading: 'Solar energy' });
    expect(resolved).not.toBeNull();
    expect(resolved?.heading).toBe('Solar energy');
    expect(resolved?.body).toContain('Solar panels store energy.');
    expect(resolved?.body).toContain('Battery storage holds charge.');
    expect(resolved?.body).not.toContain('Turbines capture wind.');
    expect(resolved?.hasImage).toBe(false);
  });

  it('resolves an explicit section container addressed by its leading heading', () => {
    const resolved = resolveSectionVisual(CONTAINER_DOC, { kind: 'section', sectionPath: [1], anchorPath: [1, 0] });
    expect(resolved).not.toBeNull();
    expect(resolved?.heading).toBe('Storage');
    expect(resolved?.body).toContain('Batteries hold charge.');
    expect(resolved?.hasImage).toBe(false);
  });

  it('reports an existing image in the section so a duplicate is not added', () => {
    const withImage = doc([
      {
        type: 'section',
        children: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Storage' }] },
          { type: 'image', attrs: { mediaId: 'm1', src: 'https://x.test/a.png', alt: 'Battery' } },
        ],
      },
    ]);
    const resolved = resolveSectionVisual(withImage, { kind: 'section', sectionPath: [0], anchorPath: [0, 0] });
    expect(resolved?.hasImage).toBe(true);
  });

  it('stops the region at the next heading of the same or higher level', () => {
    const nested = doc([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Top' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Top body.' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Child' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Child body.' }] },
    ]);
    const resolved = resolveSectionVisual(nested, { kind: 'section', sectionPath: [0], anchorPath: [0] });
    expect(resolved?.body).toContain('Top body.');
    expect(resolved?.body).toContain('Child body.');
  });

  it('returns null for an invalid or mismatched target instead of guessing', () => {
    expect(resolveSectionVisual(REGION_DOC, { kind: 'section', sectionPath: [9], anchorPath: [9] })).toBeNull();
    expect(resolveSectionVisual(REGION_DOC, { kind: 'section', sectionPath: [1], anchorPath: [1] })).toBeNull();
    expect(resolveSectionVisual(CONTAINER_DOC, { kind: 'section', sectionPath: [0], anchorPath: [1, 0] })).toBeNull();
    expect(resolveSectionVisual(CONTAINER_DOC, { kind: 'section', sectionPath: [1], anchorPath: [1, 9] })).toBeNull();
  });

  it('bounds the derived body text', () => {
    const long = doc([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Long' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'word '.repeat(1000) }] },
    ]);
    const resolved = resolveSectionVisual(long, { kind: 'section', sectionPath: [0], anchorPath: [0] });
    expect((resolved?.body.length ?? 0) <= SECTION_VISUAL_MAX_BODY_CHARS).toBe(true);
  });
});
