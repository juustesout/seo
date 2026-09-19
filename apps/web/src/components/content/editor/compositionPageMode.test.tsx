import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import type { TipDoc, TipNode } from '@seo/contracts';
import { DEFAULT_DESIGN_SYSTEM, resolveDesignSystem } from '@seo/contracts';
import { RichTextEditor } from '../RichTextEditor';

const compositionCss = readFileSync(
  resolve(process.cwd(), 'src/components/content/editor/compositionEditor.css'),
  'utf8',
);

function card(text: string): TipNode {
  return {
    type: 'compositionFeatureCard',
    content: [{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text }] }],
  };
}

function compositionDoc(): TipDoc {
  return {
    type: 'doc',
    content: [
      {
        type: 'compositionHero',
        attrs: { variant: 'centered' },
        content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hero' }] }],
      },
      {
        type: 'compositionSection',
        content: [{ type: 'compositionFeatureGrid', content: [card('One'), card('Two')] }],
      },
      {
        type: 'compositionCta',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Get started' }] }],
      },
      {
        type: 'compositionButton',
        attrs: { variant: 'primary' },
        content: [{ type: 'text', text: 'Start' }],
      },
    ],
  };
}

function articleDoc(): TipDoc {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Article' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Long-form copy' }] },
    ],
  };
}

/** Extracts the declaration block of the first rule whose selector contains `selector`. */
function ruleBlock(css: string, selector: string): string {
  const index = css.indexOf(selector);
  if (index === -1) return '';
  const start = css.indexOf('{', index);
  const end = css.indexOf('}', start);
  if (start === -1 || end === -1) return '';
  return css.slice(start + 1, end);
}

describe('composition page canvas (Stage 8E.5)', () => {
  it('activates page mode for a composition document', async () => {
    const { container } = render(<RichTextEditor initialDoc={compositionDoc()} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    expect(container.querySelector('.rt-editor')?.getAttribute('data-canvas-mode')).toBe('page');
    expect(container.querySelector('[data-editor-canvas="composition"]')).toBeTruthy();
    expect(container.querySelector('.cosmos-doc .cosmos-container .ProseMirror')).toBeTruthy();
  });

  it('keeps article mode for legacy article content', async () => {
    const { container } = render(<RichTextEditor initialDoc={articleDoc()} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    expect(container.querySelector('.rt-editor')?.getAttribute('data-canvas-mode')).toBe('article');
    expect(container.querySelector('.cosmos-doc')).toBeNull();
    expect(container.querySelector('[data-editor-canvas="composition"]')).toBeNull();
  });

  it('switches to page mode once composition is inserted into an article', async () => {
    let live: Editor | null = null;
    const { container } = render(
      <RichTextEditor initialDoc={articleDoc()} onEditor={(e) => { live = e; }} />,
    );
    await waitFor(() => expect(live).toBeTruthy());
    expect(container.querySelector('.rt-editor')?.getAttribute('data-canvas-mode')).toBe('article');

    live!.chain().focus().insertContent({
      type: 'compositionHero',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hero' }] }],
    }).run();

    await waitFor(() =>
      expect(container.querySelector('.rt-editor')?.getAttribute('data-canvas-mode')).toBe('page'),
    );
    expect(container.querySelector('.cosmos-doc .cosmos-container .cosmos-hero')).toBeTruthy();
  });

  it('gives composition NodeViews the CanonicalRenderer block classes', async () => {
    const { container } = render(<RichTextEditor initialDoc={compositionDoc()} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());

    const hero = container.querySelector('[data-composition="compositionHero"] .seo-composition__content');
    expect(hero?.className).toContain('cosmos-block');
    expect(hero?.className).toContain('cosmos-hero');
    expect(hero?.className).toContain('cosmos-hero--centered');

    const grid = container.querySelector('[data-composition="compositionFeatureGrid"] .seo-composition__content');
    expect(grid?.className).toContain('cosmos-featureGrid');

    const cardNode = container.querySelector('[data-composition="compositionFeatureCard"]');
    expect(cardNode?.className).toContain('cosmos-featureCard');

    const cta = container.querySelector('[data-composition="compositionCta"] .seo-composition__content');
    expect(cta?.className).toContain('cosmos-cta');

    const button = container.querySelector('[data-composition="compositionButton"] .seo-composition__content');
    expect(button?.className).toContain('cosmos-button');
    expect(button?.className).toContain('cosmos-button--primary');
  });

  it('applies layout intent through the shared canonical mapping', async () => {
    const doc: TipDoc = {
      type: 'doc',
      content: [
        {
          type: 'compositionFeatureGrid',
          attrs: { layout: { columns: 3, align: 'center' } },
          content: [card('One'), card('Two'), card('Three')],
        },
      ],
    };
    const { container } = render(<RichTextEditor initialDoc={doc} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    const grid = container.querySelector('[data-composition="compositionFeatureGrid"] .seo-composition__content');
    expect(grid?.className).toContain('cosmos-columns-3');
    expect(grid?.className).toContain('cosmos-align-center');
  });

  it('renders the editor canvas with the effective design system tokens', async () => {
    const { container } = render(
      <RichTextEditor
        initialDoc={compositionDoc()}
        designSystem={resolveDesignSystem({ colors: { primary: '#111111' } })}
      />,
    );
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    const canvas = container.querySelector<HTMLElement>('[data-editor-canvas="composition"]');
    expect(canvas?.style.getPropertyValue('--cosmos-color-primary')).toBe('#111111');
  });

  it('falls back to the default design system when none is resolved', async () => {
    const { container } = render(<RichTextEditor initialDoc={compositionDoc()} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    const canvas = container.querySelector<HTMLElement>('[data-editor-canvas="composition"]');
    expect(canvas?.style.getPropertyValue('--cosmos-color-primary')).toBe(DEFAULT_DESIGN_SYSTEM.colors.primary);
  });

  it('agrees with the renderer token set for the same design system', async () => {
    const designSystem = resolveDesignSystem({ colors: { primary: '#0a0a0a' }, spacingScale: 'spacious' });
    const { container } = render(<RichTextEditor initialDoc={compositionDoc()} designSystem={designSystem} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    const canvas = container.querySelector<HTMLElement>('[data-editor-canvas="composition"]');
    expect(canvas).toBeTruthy();
    expect(canvas!.style.getPropertyValue('--cosmos-color-primary')).toBe(designSystem.colors.primary);
    expect(canvas!.style.getPropertyValue('--cosmos-space-md')).toBe(designSystem.spacing.md);
    expect(canvas!.style.getPropertyValue('--cosmos-radius-card')).toBe(designSystem.shape.card);
  });

  it('keeps editor chrome hidden until hover or selection so an idle canvas matches the renderer', () => {
    const chrome = ruleBlock(compositionCss, '.seo-composition__chrome');
    expect(chrome).toMatch(/position\s*:\s*absolute/);
    expect(chrome).toMatch(/opacity\s*:\s*0/);
  });

  it('draws selection with an outline only, never layout-affecting box properties', () => {
    const selected = ruleBlock(compositionCss, '.seo-composition-selected');
    expect(selected).toMatch(/outline\s*:/);
    expect(selected).not.toMatch(/(?:^|[^-\w])(?:padding|margin|width|height)\s*:/);
  });
});
