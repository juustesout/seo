import { describe, expect, it } from 'vitest';
import {
  CANONICAL_BLOCK_VARIANTS,
  CANONICAL_COMPOSITION_BLOCK_TYPES,
  CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES,
  CANONICAL_DOCUMENT_VERSION,
  CANONICAL_LAYOUT_ALIGNMENTS,
  CANONICAL_LAYOUT_DENSITIES,
  CANONICAL_LAYOUT_DIRECTIONS,
  CANONICAL_LAYOUT_WIDTHS,
  CANONICAL_MAX_LAYOUT_COLUMNS,
  canonicalBlockTypeOf,
  canonicalLayoutIntentOf,
  canonicalVariantOf,
  isValidCanonicalDoc,
  type CanonicalBlock,
  type CanonicalDocument,
  type CanonicalMeta,
} from './canonical.js';
import { canonicalToTiptap } from './tiptapAdapter.js';
import { serializeWordPressBlocks } from './wordpressAdapter.js';

const V = CANONICAL_DOCUMENT_VERSION;

function doc(blocks: unknown[], meta?: unknown): CanonicalDocument {
  return { version: V, blocks: blocks as CanonicalBlock[], meta: meta as CanonicalMeta | undefined };
}

function text(value: string): CanonicalBlock {
  return { type: 'paragraph', content: [{ type: 'text', text: value }] };
}

function heading(value: string): CanonicalBlock {
  return { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: value }] };
}

function ok(blocks: unknown[], meta?: unknown): boolean {
  return isValidCanonicalDoc(doc(blocks, meta));
}

describe('composition vocabulary', () => {
  it('keeps every Stage 1-3 block type valid', () => {
    const legacy: CanonicalBlock[] = [
      text('p'),
      heading('h'),
      { type: 'list', attrs: { ordered: false }, children: [{ type: 'listItem', content: [{ type: 'text', text: 'i' }] }] },
      { type: 'quote', content: [{ type: 'text', text: 'q' }] },
      { type: 'code', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'c' }] },
      { type: 'image', attrs: { mediaId: 'm', width: 10, height: 10 } },
      { type: 'divider' },
      { type: 'table', children: [{ type: 'tableRow', children: [{ type: 'tableCell', content: [{ type: 'text', text: 'x' }] }] }] },
      { type: 'group', children: [text('g')] },
      { type: 'columns', children: [{ type: 'column', children: [text('col')] }] },
      { type: 'embed', attrs: { url: 'https://example.com' } },
      { type: 'html', rawHtml: '<div>raw</div>' },
      { type: 'custom', source: { cms: 'wordpress', type: 'acme/thing' }, children: [text('custom')] },
    ];
    expect(ok(legacy)).toBe(true);
  });

  it('registers every composition and leaf type in the known vocabulary', () => {
    for (const type of [...CANONICAL_COMPOSITION_BLOCK_TYPES, ...CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES]) {
      expect(canonicalBlockTypeOf(type)).toBe(true);
    }
  });

  it('accepts a hero with variant, layout and structured children', () => {
    expect(
      ok([
        {
          type: 'hero',
          attrs: { variant: 'centered', layout: { align: 'center', width: 'wide', columns: 2, direction: 'column', density: 'comfortable' } },
          children: [heading('Launch faster'), text('Everything in one place.')],
        },
      ]),
    ).toBe(true);
  });

  it('accepts a feature grid of cards', () => {
    expect(
      ok([
        {
          type: 'featureGrid',
          attrs: { layout: { columns: 3 } },
          children: [
            { type: 'featureCard', attrs: { variant: 'elevated', icon: 'bolt' }, children: [heading('Fast'), text('Ship sooner.')] },
            { type: 'featureCard', attrs: { variant: 'bordered', icon: 'shield' }, children: [heading('Safe'), text('Stay compliant.')] },
          ],
        },
      ]),
    ).toBe(true);
  });

  it('accepts a cta built from a heading, button and badge', () => {
    expect(
      ok([
        {
          type: 'cta',
          attrs: { variant: 'primary', layout: { align: 'center', density: 'spacious' } },
          children: [
            heading('Start today'),
            { type: 'button', attrs: { href: 'https://example.com/signup', variant: 'secondary' }, content: [{ type: 'text', text: 'Sign up' }] },
            { type: 'badge', attrs: { variant: 'accent', icon: 'spark' }, content: [{ type: 'text', text: 'New' }] },
          ],
        },
      ]),
    ).toBe(true);
  });

  it('accepts composition nested inside composition and keeps content addressable', () => {
    const blocks: CanonicalBlock[] = [
      {
        type: 'hero',
        attrs: { variant: 'split' },
        children: [
          {
            type: 'section',
            children: [
              {
                type: 'mediaText',
                attrs: { variant: 'image-left' },
                children: [{ type: 'image', attrs: { mediaId: 'm1', alt: 'shot' } }, text('Body copy')],
              },
            ],
          },
        ],
      },
    ];
    expect(ok(blocks)).toBe(true);
    const before = structuredClone(blocks);
    isValidCanonicalDoc(doc(blocks));
    expect(blocks).toEqual(before);
  });

  it('accepts every declared variant for its host type', () => {
    for (const [type, variants] of Object.entries(CANONICAL_BLOCK_VARIANTS)) {
      for (const variant of variants) {
        expect(ok([{ type, attrs: { variant } }])).toBe(true);
      }
    }
  });

  it('rejects unknown or mismatched variants', () => {
    expect(ok([{ type: 'hero', attrs: { variant: 'neon' } }])).toBe(false);
    expect(ok([{ type: 'callout', attrs: { variant: 'centered' } }])).toBe(false);
    expect(ok([{ type: 'hero', attrs: { variant: 3 } }])).toBe(false);
  });

  it('accepts every layout intent value and bound', () => {
    for (const align of CANONICAL_LAYOUT_ALIGNMENTS) {
      for (const direction of CANONICAL_LAYOUT_DIRECTIONS) {
        for (const width of CANONICAL_LAYOUT_WIDTHS) {
          for (const density of CANONICAL_LAYOUT_DENSITIES) {
            expect(ok([{ type: 'section', attrs: { layout: { align, direction, width, density } } }])).toBe(true);
          }
        }
      }
    }
    expect(ok([{ type: 'featureGrid', attrs: { layout: { columns: 1 } } }])).toBe(true);
    expect(ok([{ type: 'featureGrid', attrs: { layout: { columns: CANONICAL_MAX_LAYOUT_COLUMNS } } }])).toBe(true);
  });

  it('rejects malformed layout intents', () => {
    expect(ok([{ type: 'hero', attrs: { layout: 'constrained' } }])).toBe(false);
    expect(ok([{ type: 'hero', attrs: { layout: { align: 'middle' } } }])).toBe(false);
    expect(ok([{ type: 'hero', attrs: { layout: { direction: 'sideways' } } }])).toBe(false);
    expect(ok([{ type: 'hero', attrs: { layout: { width: 'huge' } } }])).toBe(false);
    expect(ok([{ type: 'hero', attrs: { layout: { density: 'tight' } } }])).toBe(false);
    expect(ok([{ type: 'hero', attrs: { layout: { columns: 0 } } }])).toBe(false);
    expect(ok([{ type: 'hero', attrs: { layout: { columns: CANONICAL_MAX_LAYOUT_COLUMNS + 1 } } }])).toBe(false);
    expect(ok([{ type: 'hero', attrs: { layout: { columns: 2.5 } } }])).toBe(false);
    expect(ok([{ type: 'hero', attrs: { layout: { columns: '2' } } }])).toBe(false);
  });

  it('rejects arbitrary CSS anywhere it could be smuggled in', () => {
    expect(ok([{ type: 'hero', attrs: { style: 'color:red' } }])).toBe(false);
    expect(ok([{ type: 'callout', attrs: { color: 'red' } }])).toBe(false);
    expect(ok([{ type: 'featureCard', attrs: { marginTop: 37 } }])).toBe(false);
    expect(ok([{ type: 'hero', attrs: { layout: { marginLeft: 37 } } }])).toBe(false);
    expect(ok([{ type: 'hero', attrs: { layout: { gridTemplateColumns: '1fr 1fr' } } }])).toBe(false);
    expect(ok([{ type: 'paragraph', attrs: { style: 'color:red' } }])).toBe(false);
    expect(ok([{ type: 'image', attrs: { className: 'rounded', src: 's' } }])).toBe(false);
  });

  it('preserves custom blocks and their lossless envelopes unchanged', () => {
    const custom: CanonicalBlock = {
      type: 'custom',
      source: { cms: 'wordpress', type: 'acme/badge', attrs: { text: 'New' }, innerContent: ['<span>', null, '</span>'] },
      children: [text('New')],
    };
    expect(ok([custom])).toBe(true);
    const before = structuredClone(custom);
    isValidCanonicalDoc(doc([custom]));
    expect(custom).toEqual(before);
  });

  it('validates the meta.designSystem reference and rejects token values', () => {
    expect(ok([text('p')], { designSystem: { id: 'acme', variant: 'dark', version: '2' } })).toBe(true);
    expect(ok([text('p')], { designSystem: {} })).toBe(true);
    expect(ok([text('p')], { designSystem: { id: '' } })).toBe(false);
    expect(ok([text('p')], { designSystem: { tokens: { color: '#fff' } } })).toBe(false);
    expect(ok([text('p')], { designSystem: 'acme' })).toBe(false);
  });

  it('exposes deterministic variant and layout helpers', () => {
    const hero: CanonicalBlock = { type: 'hero', attrs: { variant: 'centered', layout: { density: 'compact', align: 'right' } } };
    expect(canonicalVariantOf(hero)).toBe('centered');
    expect(canonicalVariantOf({ type: 'hero', attrs: { variant: 'neon' } })).toBeUndefined();
    expect(canonicalVariantOf(text('p'))).toBeUndefined();

    const normalized = canonicalLayoutIntentOf(hero);
    expect(normalized).toEqual({ align: 'right', density: 'compact' });
    expect(Object.keys(normalized ?? {})).toEqual(['align', 'density']);
    expect(canonicalLayoutIntentOf({ type: 'hero', attrs: { layout: { align: 'middle' } } })).toBeUndefined();
  });

  it('degrades composition blocks in TipTap and WordPress without dropping content', () => {
    const blocks: CanonicalBlock[] = [
      {
        type: 'hero',
        attrs: { variant: 'centered', layout: { align: 'center' } },
        children: [heading('Big idea'), text('Supporting copy')],
      },
    ];
    const value = doc(blocks);
    expect(isValidCanonicalDoc(value)).toBe(true);

    const tiptap = JSON.stringify(canonicalToTiptap(value));
    expect(tiptap).toContain('Big idea');
    expect(tiptap).toContain('Supporting copy');

    const wp = serializeWordPressBlocks(value);
    expect(wp).toContain('Big idea');
    expect(wp).toContain('Supporting copy');
    expect(serializeWordPressBlocks(value)).toBe(wp);
  });
});
