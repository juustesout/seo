import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  CANONICAL_DOCUMENT_VERSION,
  resolveDesignSystem,
  type CanonicalBlock,
  type CanonicalDocument,
} from '@seo/contracts';
import { CanonicalRenderer, renderCanonicalDocument } from './CanonicalRenderer';
import {
  blockClassNames,
  columnsClassNames,
  layoutClassNames,
  responsiveColumnsStrategy,
  variantClassNames,
} from './presentation';
import { safeHref, safeImageSrc } from './safety';

function doc(blocks: CanonicalBlock[]): CanonicalDocument {
  return { version: CANONICAL_DOCUMENT_VERSION, blocks };
}

function text(value: string): CanonicalBlock {
  return { type: 'paragraph', content: [{ type: 'text', text: value }] };
}

function rootOf(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>('[data-cosmos-document]');
  if (!root) throw new Error('renderer root not found');
  return root;
}

function marketingDoc(): CanonicalDocument {
  return doc([
    {
      type: 'hero',
      attrs: { variant: 'split', layout: { align: 'left', width: 'wide' } },
      children: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Ship SEO faster' }] },
        text('One platform for the whole team.'),
        {
          type: 'cta',
          attrs: { variant: 'primary' },
          children: [{ type: 'button', attrs: { href: '/signup' }, content: [{ type: 'text', text: 'Get started' }] }],
        },
      ],
    },
    {
      type: 'featureGrid',
      attrs: { layout: { columns: 3 } },
      children: [1, 2, 3].map((n) => ({
        type: 'featureCard',
        attrs: { variant: 'elevated' },
        children: [
          { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: `Feature ${n}` }] },
          text(`Detail ${n}`),
        ],
      })),
    },
    {
      type: 'mediaText',
      attrs: { variant: 'image-left' },
      children: [
        { type: 'image', attrs: { src: 'https://cdn.example.com/shot.png', alt: 'Dashboard' } },
        text('See everything in one view.'),
      ],
    },
    {
      type: 'testimonial',
      children: [
        { type: 'quote', content: [{ type: 'text', text: 'It just works.' }] },
        text('-- A customer'),
      ],
    },
    {
      type: 'cta',
      attrs: { variant: 'secondary', layout: { align: 'center', density: 'spacious' } },
      children: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Ready?' }] },
        { type: 'button', attrs: { href: 'https://example.com/signup' }, content: [{ type: 'text', text: 'Start free' }] },
      ],
    },
  ]);
}

describe('renderer tokens and isolation', () => {
  it('scopes tokens to the container without mutating the global theme', () => {
    const documentEl = doc([text('a')]);
    const a = render(<CanonicalRenderer document={documentEl} designSystem={resolveDesignSystem({ colors: { primary: '#111111' } })} />);
    const b = render(<CanonicalRenderer document={documentEl} designSystem={resolveDesignSystem({ colors: { primary: '#222222' } })} />);

    expect(rootOf(a.container).style.getPropertyValue('--cosmos-color-primary')).toBe('#111111');
    expect(rootOf(b.container).style.getPropertyValue('--cosmos-color-primary')).toBe('#222222');
    expect(document.documentElement.getAttribute('style')).toBeNull();
    expect(document.body.getAttribute('style')).toBeNull();
  });

  it('ships a full default token set when no Cosmos config is supplied', () => {
    const { container } = render(<CanonicalRenderer document={doc([text('a')])} />);
    const root = rootOf(container);
    expect(root.style.getPropertyValue('--cosmos-color-text')).toBeTruthy();
    expect(root.style.getPropertyValue('--cosmos-space-md')).toBeTruthy();
    expect(root.style.getPropertyValue('--cosmos-radius-card')).toBeTruthy();
    expect(root.style.getPropertyValue('--cosmos-shadow-elevated')).toBeTruthy();
  });
});

describe('content blocks', () => {
  it('renders paragraph, heading, list, quote and code with semantic elements', () => {
    const { container } = render(
      <CanonicalRenderer
        document={doc([
          text('Hello world'),
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section' }] },
          {
            type: 'list',
            attrs: { ordered: true, start: 3 },
            children: [{ type: 'listItem', content: [{ type: 'text', text: 'first' }] }],
          },
          { type: 'quote', content: [{ type: 'text', text: 'quoted' }] },
          { type: 'code', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const x = 1;' }] },
        ])}
      />,
    );
    expect(container.querySelector('p')?.textContent).toBe('Hello world');
    expect(container.querySelector('h2')?.textContent).toBe('Section');
    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    expect(ol?.getAttribute('start')).toBe('3');
    expect(container.querySelector('li')?.textContent).toBe('first');
    expect(container.querySelector('blockquote')?.textContent).toBe('quoted');
    expect(container.querySelector('pre code')?.textContent).toBe('const x = 1;');
    expect(container.querySelector('pre')?.getAttribute('data-language')).toBe('ts');
  });

  it('renders an image with alt text and a placeholder when the source is unsafe', () => {
    const good = render(
      <CanonicalRenderer document={doc([{ type: 'image', attrs: { src: 'https://cdn/x.png', alt: 'A shot' } }])} />,
    );
    expect(good.container.querySelector('img')?.getAttribute('alt')).toBe('A shot');
    const bad = render(
      <CanonicalRenderer document={doc([{ type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'nope' } }])} />,
    );
    expect(bad.container.querySelector('img')).toBeNull();
    expect(bad.container.querySelector('[role="img"]')?.textContent).toContain('nope');
  });
});

describe('composition blocks', () => {
  const blocks: CanonicalBlock[] = [
    { type: 'hero', children: [text('hero')] },
    { type: 'section', children: [text('section')] },
    { type: 'featureGrid', children: [{ type: 'featureCard', children: [text('card')] }] },
    { type: 'cta', children: [text('cta')] },
    { type: 'callout', children: [text('callout')] },
    { type: 'testimonial', children: [text('testimonial')] },
    { type: 'stats', children: [{ type: 'statItem', attrs: { value: '42' }, content: [{ type: 'text', text: 'users' }] }] },
    { type: 'mediaText', children: [text('media')] },
    {
      type: 'footer',
      children: [{ type: 'button', attrs: { href: '/contact' }, content: [{ type: 'text', text: 'Contact' }] }],
    },
    { type: 'badge', content: [{ type: 'text', text: 'New' }] },
  ];

  it('renders every composition type with its semantic root', () => {
    const { container } = render(<CanonicalRenderer document={doc(blocks)} />);
    for (const type of ['hero', 'section', 'featureGrid', 'featureCard', 'cta', 'callout', 'testimonial', 'stats', 'statItem', 'mediaText', 'footer', 'badge']) {
      expect(container.querySelector(`.cosmos-${type}`)).not.toBeNull();
    }
    expect(container.querySelector('dl .cosmos-stat__value')?.textContent).toBe('42');
    expect(container.querySelector('.cosmos-badge')?.textContent).toBe('New');
  });

  it('renders button as a link when it has a safe href, else a non-interactive element', () => {
    const { container } = render(
      <CanonicalRenderer
        document={doc([
          { type: 'button', attrs: { href: 'https://example.com' }, content: [{ type: 'text', text: 'Go' }] },
          { type: 'button', content: [{ type: 'text', text: 'Static' }] },
          { type: 'button', attrs: { href: 'javascript:alert(1)' }, content: [{ type: 'text', text: 'Bad' }] },
        ])}
      />,
    );
    const anchors = container.querySelectorAll('a.cosmos-button');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute('href')).toBe('https://example.com');
    const spans = container.querySelectorAll('span.cosmos-button');
    expect(spans).toHaveLength(2);
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders the marketing fixture with the expected structure', () => {
    const { container } = render(<CanonicalRenderer document={marketingDoc()} />);
    expect(container.querySelector('h1')?.textContent).toBe('Ship SEO faster');
    expect(container.querySelectorAll('.cosmos-featureCard')).toHaveLength(3);
    expect(container.querySelector('.cosmos-mediaText img')?.getAttribute('alt')).toBe('Dashboard');
    expect(container.querySelector('figure.cosmos-testimonial blockquote')?.textContent).toBe('It just works.');
    const ctaButtons = container.querySelectorAll('.cosmos-cta a.cosmos-button');
    expect(ctaButtons).toHaveLength(2);
    expect(ctaButtons[0]?.getAttribute('href')).toBe('/signup');
    expect(ctaButtons[1]?.getAttribute('href')).toBe('https://example.com/signup');
  });
});

describe('variants', () => {
  it('maps semantic variants to renderer tokens', () => {
    const { container } = render(
      <CanonicalRenderer
        document={doc([
          { type: 'hero', attrs: { variant: 'split' }, children: [text('h')] },
          { type: 'callout', attrs: { variant: 'warning' }, children: [text('c')] },
          { type: 'featureCard', attrs: { variant: 'elevated' }, children: [text('f')] },
        ])}
      />,
    );
    expect(container.querySelector('.cosmos-hero--split')).not.toBeNull();
    expect(container.querySelector('.cosmos-callout--warning')).not.toBeNull();
    expect(container.querySelector('.cosmos-featureCard--elevated')).not.toBeNull();
  });

  it('variantClassNames is pure and bounded', () => {
    expect(variantClassNames('hero', 'split')).toEqual(['cosmos-hero--split']);
    expect(variantClassNames('hero', undefined)).toEqual([]);
  });
});

describe('layout intent', () => {
  it('maps validated layout intent to renderer tokens', () => {
    const { container } = render(
      <CanonicalRenderer
        document={doc([
          {
            type: 'hero',
            attrs: { layout: { align: 'center', direction: 'row', columns: 3, width: 'wide', density: 'compact' } },
            children: [text('h')],
          },
        ])}
      />,
    );
    const hero = container.querySelector('.cosmos-hero');
    for (const token of ['cosmos-align-center', 'cosmos-direction-row', 'cosmos-columns-3', 'cosmos-width-wide', 'cosmos-density-compact']) {
      expect(hero?.classList.contains(token)).toBe(true);
    }
  });

  it('layoutClassNames ignores unknown/invalid intent', () => {
    expect(layoutClassNames(undefined)).toEqual([]);
    expect(layoutClassNames({ align: 'center', columns: 2 })).toEqual(['cosmos-align-center', 'cosmos-columns-2']);
  });

  it('blockClassNames is derived from canonical helpers only', () => {
    const block: CanonicalBlock = { type: 'hero', attrs: { variant: 'centered', layout: { width: 'full' } } };
    expect(blockClassNames(block)).toEqual(['cosmos-block', 'cosmos-hero', 'cosmos-hero--centered', 'cosmos-width-full']);
  });
});

describe('responsive intent', () => {
  it('owns column breakpoints in the renderer, not the document', () => {
    expect(responsiveColumnsStrategy(1)).toEqual({ base: 1, sm: 1, lg: 1 });
    expect(responsiveColumnsStrategy(2)).toEqual({ base: 1, sm: 2, lg: 2 });
    expect(responsiveColumnsStrategy(3)).toEqual({ base: 1, sm: 2, lg: 3 });
    expect(responsiveColumnsStrategy(6)).toEqual({ base: 1, sm: 2, lg: 6 });
    expect(responsiveColumnsStrategy(99)).toEqual({ base: 1, sm: 2, lg: 6 });
    expect(columnsClassNames(3)).toEqual(['cosmos-columns-3']);
  });

  it('never writes responsive values back into the document', () => {
    const documentValue = doc([
      { type: 'featureGrid', attrs: { layout: { columns: 3 } }, children: [{ type: 'featureCard', children: [text('c')] }] },
    ]);
    const before = structuredClone(documentValue);
    render(<CanonicalRenderer document={documentValue} />);
    expect(documentValue).toEqual(before);
  });
});

describe('safety fallbacks', () => {
  it('renders unknown blocks via children, then text, without crashing', () => {
    const { container } = render(
      <CanonicalRenderer
        document={doc([
          { type: 'acme/widget', children: [text('nested')] },
          { type: 'acme/leaf', content: [{ type: 'text', text: 'leaf text' }] },
          { type: 'acme/empty' },
        ])}
      />,
    );
    expect(container.querySelector('[data-cosmos-unsupported="acme/widget"]')?.textContent).toContain('nested');
    expect(container.querySelector('[data-cosmos-unsupported="acme/leaf"]')?.textContent).toContain('leaf text');
    expect(container.querySelector('[data-cosmos-unsupported="acme/empty"]')?.textContent).toContain('[unsupported:acme/empty]');
  });

  it('never injects raw HTML as live markup', () => {
    const payload = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const { container } = render(
      <CanonicalRenderer
        document={doc([
          { type: 'html', rawHtml: payload },
          { type: 'custom', source: { cms: 'wordpress', type: 'acme/embed' }, rawHtml: payload },
        ])}
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('keeps unsupported inline content visible', () => {
    const { container } = render(
      <CanonicalRenderer
        document={doc([
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'before ' },
              { type: 'inlineUnsupported', source: { cms: 'wordpress', type: 'core/emoji' } },
            ],
          },
        ])}
      />,
    );
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('[unsupported:core/emoji]');
  });

  it('rejects executable URLs', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,<script>')).toBeUndefined();
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('/relative')).toBe('/relative');
    expect(safeImageSrc('javascript:alert(1)')).toBeUndefined();
    expect(safeImageSrc('data:text/html;base64,AAAA')).toBeUndefined();
    expect(safeImageSrc('https://cdn/x.png')).toBe('https://cdn/x.png');
  });
});

describe('design system isolation', () => {
  it('keeps structure identical while tokens change presentation', () => {
    const value = marketingDoc();
    const a = render(<CanonicalRenderer document={value} designSystem={resolveDesignSystem({ colors: { primary: '#111111' } })} />);
    const b = render(<CanonicalRenderer document={value} designSystem={resolveDesignSystem({ colors: { primary: '#222222' } })} />);

    const rootA = rootOf(a.container);
    const rootB = rootOf(b.container);
    expect(rootA.innerHTML).toBe(rootB.innerHTML);
    expect(rootA.getAttribute('style')).not.toBe(rootB.getAttribute('style'));
    expect(rootA.style.getPropertyValue('--cosmos-color-primary')).toBe('#111111');
    expect(rootB.style.getPropertyValue('--cosmos-color-primary')).toBe('#222222');
    expect(document.documentElement.getAttribute('style')).toBeNull();
  });

  it('renderCanonicalDocument returns a renderable element', () => {
    const { container } = render(<>{renderCanonicalDocument(doc([text('via function')]))}</>);
    expect(container.textContent).toContain('via function');
  });
});
