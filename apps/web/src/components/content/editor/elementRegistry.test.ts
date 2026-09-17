import { describe, expect, it } from 'vitest';
import {
  EDITOR_ELEMENTS,
  getEditorElement,
  groupEditorElements,
  resolveElementType,
} from './elementRegistry';

describe('element registry', () => {
  it('contains the existing content, media and composition elements', () => {
    const types = EDITOR_ELEMENTS.map((el) => el.type);
    expect(types).toEqual(['paragraph', 'heading', 'image', 'compositionHero', 'compositionCta']);
    expect(EDITOR_ELEMENTS.map((el) => el.label)).toEqual(['Text', 'Heading', 'Image', 'Hero', 'CTA']);
  });

  it('groups elements by category without per-type branches', () => {
    expect(groupEditorElements()).toEqual([
      {
        category: 'Content',
        elements: [
          expect.objectContaining({ type: 'paragraph', label: 'Text' }),
          expect.objectContaining({ type: 'heading', label: 'Heading' }),
        ],
      },
      { category: 'Media', elements: [expect.objectContaining({ type: 'image', label: 'Image' })] },
      {
        category: 'Composition',
        elements: [
          expect.objectContaining({ type: 'compositionHero', label: 'Hero' }),
          expect.objectContaining({ type: 'compositionCta', label: 'CTA' }),
        ],
      },
    ]);
  });

  it('resolves canonical aliases to registered editor types', () => {
    expect(resolveElementType('hero')).toBe('compositionHero');
    expect(resolveElementType('cta')).toBe('compositionCta');
    expect(resolveElementType('text')).toBe('paragraph');
    expect(getEditorElement('hero')?.label).toBe('Hero');
    expect(getEditorElement('unknown-type')).toBeUndefined();
  });
});
