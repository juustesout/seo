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
    expect(types).toEqual([
      'paragraph',
      'heading',
      'image',
      'compositionHero',
      'compositionSection',
      'compositionFeatureGrid',
      'compositionFeatureCard',
      'compositionCta',
    ]);
    expect(EDITOR_ELEMENTS.map((el) => el.label)).toEqual([
      'Text',
      'Heading',
      'Image',
      'Hero',
      'Section',
      'Feature Grid',
      'Feature Card',
      'CTA',
    ]);
  });

  it('groups elements by category without per-type branches', () => {
    const groups = groupEditorElements();
    expect(groups.map((group) => group.category)).toEqual(['Content', 'Media', 'Composition']);
    expect(groups[2]?.elements.map((el) => el.type)).toEqual([
      'compositionHero',
      'compositionSection',
      'compositionFeatureGrid',
      'compositionFeatureCard',
      'compositionCta',
    ]);
  });

  it('resolves canonical aliases to registered editor types', () => {
    expect(resolveElementType('hero')).toBe('compositionHero');
    expect(resolveElementType('section')).toBe('compositionSection');
    expect(resolveElementType('featureGrid')).toBe('compositionFeatureGrid');
    expect(resolveElementType('featureCard')).toBe('compositionFeatureCard');
    expect(resolveElementType('cta')).toBe('compositionCta');
    expect(resolveElementType('text')).toBe('paragraph');
    expect(getEditorElement('hero')?.label).toBe('Hero');
    expect(getEditorElement('unknown-type')).toBeUndefined();
  });
});
