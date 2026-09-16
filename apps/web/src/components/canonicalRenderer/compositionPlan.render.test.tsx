import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  MARKETING_STORYBOARD_PLAN,
  canonicalBlockTypeOf,
  compileCompositionPlan,
  isValidCanonicalDoc,
  type CanonicalBlock,
} from '@seo/contracts';
import { CanonicalRenderer } from './CanonicalRenderer';
import { hasCanonicalBlockRenderer } from './blocks';

function collectTypes(blocks: CanonicalBlock[], out = new Set<string>()): Set<string> {
  for (const block of blocks) {
    out.add(block.type);
    if (block.children) collectTypes(block.children, out);
  }
  return out;
}

describe('composition plan to renderer round trip', () => {
  it('compiles the marketing storyboard into a canonically valid document', () => {
    const document = compileCompositionPlan(MARKETING_STORYBOARD_PLAN);
    expect(isValidCanonicalDoc(document)).toBe(true);
  });

  it('only produces block types the renderer registry recognizes', () => {
    const document = compileCompositionPlan(MARKETING_STORYBOARD_PLAN);
    const types = collectTypes(document.blocks);
    expect(types.size).toBeGreaterThan(0);
    for (const type of types) {
      expect(canonicalBlockTypeOf(type)).toBe(true);
      expect(hasCanonicalBlockRenderer(type)).toBe(true);
    }
  });

  it('renders the compiled storyboard without special-case code', () => {
    const document = compileCompositionPlan(MARKETING_STORYBOARD_PLAN);
    const { container } = render(<CanonicalRenderer document={document} />);

    expect(container.querySelector('[data-cosmos-document]')).not.toBeNull();
    expect(container.querySelector('.cosmos-hero--split')).not.toBeNull();
    expect(container.querySelector('.cosmos-hero h1')).not.toBeNull();
    expect(container.querySelectorAll('.cosmos-featureGrid .cosmos-featureCard')).toHaveLength(3);
    expect(container.querySelector('figure.cosmos-testimonial blockquote')).not.toBeNull();
    expect(container.querySelector('.cosmos-cta span.cosmos-button')).not.toBeNull();
    expect(container.querySelector('footer.cosmos-footer')).not.toBeNull();
  });

  it('invents no links, images or copy while rendering placeholders', () => {
    const document = compileCompositionPlan(MARKETING_STORYBOARD_PLAN);
    const { container } = render(<CanonicalRenderer document={document} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders deterministically for the same compiled document', () => {
    const document = compileCompositionPlan(MARKETING_STORYBOARD_PLAN);
    const a = render(<CanonicalRenderer document={document} />);
    const b = render(<CanonicalRenderer document={document} />);
    expect(a.container.innerHTML).toBe(b.container.innerHTML);
  });
});
