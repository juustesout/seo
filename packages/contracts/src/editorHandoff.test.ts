import { describe, expect, it } from 'vitest';
import type { CanonicalBlock, CanonicalDocument } from './canonical.js';
import { CANONICAL_DOCUMENT_VERSION } from './canonical.js';
import { canonicalDocumentToEditorDocument, editorDocumentToCanonical } from './editorHandoff.js';
import { isValidDocStructure, type TipNode } from './contentDoc.js';
import { MARKETING_STORYBOARD_PLAN } from './compositionPlanFixtures.js';
import { compileComposition } from './compositionPlan.js';
import {
  applyCompositionSlotFills,
  compositionSlotKindOf,
  isWritableCompositionSlot,
} from './compositionWriter.js';

function doc(blocks: CanonicalBlock[]): CanonicalDocument {
  return { version: CANONICAL_DOCUMENT_VERSION, blocks };
}

function text(value: string): CanonicalBlock {
  return { type: 'paragraph', content: [{ type: 'text', text: value }] };
}

function heading(level: number, value: string): CanonicalBlock {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text: value }] };
}

function button(label: string, attrs?: Record<string, unknown>): CanonicalBlock {
  return { type: 'button', ...(attrs ? { attrs } : {}), content: [{ type: 'text', text: label }] };
}

function nodeTypes(nodes: TipNode[] | undefined): string[] {
  return (nodes ?? []).map((node) => node.type);
}

function firstOfType(
  docValue: ReturnType<typeof canonicalDocumentToEditorDocument>,
  type: string,
): TipNode | undefined {
  return (docValue.content ?? []).find((node) => node.type === type);
}

function textOf(node: TipNode | undefined): string {
  return (node?.content ?? []).map((child) => child.text ?? '').join('');
}

function hasType(nodes: TipNode[] | undefined, type: string): boolean {
  for (const node of nodes ?? []) {
    if (node.type === type) return true;
    if (hasType(node.content, type)) return true;
  }
  return false;
}

describe('canonicalDocumentToEditorDocument composition mapping', () => {
  it('maps headings with their level and paragraphs with their text', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([heading(1, 'Title'), text('Body copy')]),
    );
    const topHeading = firstOfType(tip, 'heading');
    expect((topHeading?.attrs as { level?: number } | undefined)?.level).toBe(1);
    expect(textOf(topHeading)).toBe('Title');
    expect(textOf(firstOfType(tip, 'paragraph'))).toBe('Body copy');
  });

  it('keeps sections as composition containers in document order', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([
        { type: 'section', children: [heading(2, 'One')] },
        { type: 'section', children: [heading(2, 'Two')] },
      ]),
    );
    expect(nodeTypes(tip.content)).toEqual(['compositionSection', 'compositionSection']);
    expect((tip.content?.[0]?.content ?? []).map(textOf)).toEqual(['One']);
    expect((tip.content?.[1]?.content ?? []).map(textOf)).toEqual(['Two']);
  });

  it('keeps feature grid and card nesting with their attrs', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([
        {
          type: 'featureGrid',
          attrs: { layout: { columns: 3 } },
          children: [
            {
              type: 'featureCard',
              attrs: { variant: 'elevated' },
              children: [heading(3, 'Fast'), text('Ship quickly.')],
            },
          ],
        },
      ]),
    );
    const grid = firstOfType(tip, 'compositionFeatureGrid');
    expect(grid?.attrs).toEqual({ layout: { columns: 3 } });
    const card = grid?.content?.[0];
    expect(card?.type).toBe('compositionFeatureCard');
    expect(card?.attrs).toEqual({ variant: 'elevated' });
    expect(card?.content?.[0]?.type).toBe('heading');
    expect(textOf(card?.content?.[1])).toBe('Ship quickly.');
  });

  it('maps CTA buttons to structural compositionButton nodes instead of paragraphs', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([
        {
          type: 'cta',
          attrs: { variant: 'primary' },
          children: [button('Get started', { variant: 'primary', href: '/signup' })],
        },
      ]),
    );
    const cta = firstOfType(tip, 'compositionCta');
    expect(cta?.attrs).toEqual({ variant: 'primary' });
    const ctaButton = cta?.content?.[0];
    expect(ctaButton?.type).toBe('compositionButton');
    expect(ctaButton?.attrs).toEqual({ variant: 'primary', href: '/signup' });
    expect(textOf(ctaButton)).toBe('Get started');
    expect(JSON.stringify(tip)).not.toContain('[unsupported');
  });

  it('maps a hero into a compositionHero container', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([
        {
          type: 'hero',
          attrs: { variant: 'centered', layout: { align: 'center' } },
          children: [heading(1, 'Ship SEO faster'), text('Intro copy')],
        },
      ]),
    );
    const hero = firstOfType(tip, 'compositionHero');
    expect(hero?.attrs).toEqual({ variant: 'centered', layout: { align: 'center' } });
    expect(hero?.content?.map(textOf)).toEqual(['Ship SEO faster', 'Intro copy']);
  });

  it('round-trips composition nesting and attrs back to canonical', () => {
    const canonical = doc([
      {
        type: 'hero',
        attrs: { variant: 'centered', layout: { align: 'center' } },
        children: [heading(1, 'Title')],
      },
      { type: 'section', children: [heading(2, 'Body')] },
      {
        type: 'featureGrid',
        attrs: { layout: { columns: 3 } },
        children: [
          { type: 'featureCard', attrs: { variant: 'elevated' }, children: [heading(3, 'Fast'), text('Ship')] },
        ],
      },
      { type: 'cta', children: [button('Go', { variant: 'primary', href: '/go' })] },
    ]);

    const back = editorDocumentToCanonical(canonicalDocumentToEditorDocument(canonical));

    expect(back.blocks.map((block) => block.type)).toEqual(['hero', 'section', 'featureGrid', 'cta']);
    expect(back.blocks[0]?.attrs).toEqual({ variant: 'centered', layout: { align: 'center' } });
    expect(back.blocks[2]?.attrs).toEqual({ layout: { columns: 3 } });
    expect(back.blocks[2]?.children?.[0]?.type).toBe('featureCard');
    expect(back.blocks[2]?.children?.[0]?.attrs).toEqual({ variant: 'elevated' });
    expect(back.blocks[3]?.children?.[0]?.type).toBe('button');
    expect(back.blocks[3]?.children?.[0]?.attrs).toEqual({ variant: 'primary', href: '/go' });
    expect(back.blocks[3]?.children?.[0]?.content?.[0]).toEqual({ type: 'text', text: 'Go' });
  });

  it('drops an unfilled media slot instead of fabricating an image', () => {
    const tip = canonicalDocumentToEditorDocument(doc([{ type: 'image' }]));
    expect(tip.content ?? []).toEqual([{ type: 'paragraph' }]);
    expect(JSON.stringify(tip)).not.toContain('"image"');
  });

  it('keeps a real image that carries a project media reference', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([{ type: 'image', attrs: { mediaId: 'media-1', alt: 'Dashboard' } }]),
    );
    const image = firstOfType(tip, 'image');
    expect((image?.attrs as { mediaId?: string } | undefined)?.mediaId).toBe('media-1');
    expect(isValidDocStructure(tip)).toBe(true);
  });

  it('does not invent nodes for empty leaves and containers', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([
        { type: 'hero', children: [] },
        { type: 'footer', children: [{ type: 'button', attrs: { href: '/x' } }] },
        { type: 'badge', content: [] },
        { type: 'statItem', attrs: { value: '' }, content: [] },
      ]),
    );
    expect(tip.content ?? []).toEqual([{ type: 'paragraph' }]);
  });

  it('flattens only containers without an editor node, keeping their children', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([
        {
          type: 'testimonial',
          children: [text('Great product'), text('Jane')],
        },
      ]),
    );
    expect(nodeTypes(tip.content)).toEqual(['paragraph', 'paragraph']);
    expect((tip.content ?? []).map(textOf)).toEqual(['Great product', 'Jane']);
  });

  it('preserves a real statItem value and label', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([{ type: 'statItem', attrs: { value: '42' }, content: [{ type: 'text', text: 'users' }] }]),
    );
    expect((tip.content ?? []).map(textOf)).toEqual(['42', 'users']);
  });
});

describe('canonicalDocumentToEditorDocument safety', () => {
  it('never mutates the canonical document', () => {
    const value = doc([
      {
        type: 'hero',
        children: [heading(1, 'Title'), { type: 'image' }, button('Go')],
      },
    ]);
    const before = structuredClone(value);
    canonicalDocumentToEditorDocument(value);
    expect(value).toEqual(before);
  });

  it('always returns a structurally valid, editable document', () => {
    const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);
    const fills = compiled.slots.slots.filter(isWritableCompositionSlot).map((ref) =>
      compositionSlotKindOf(ref) === 'items'
        ? { slot: ref.slot, items: ['one', 'two'] }
        : { slot: ref.slot, text: `copy for ${ref.slot}` },
    );
    const filled = applyCompositionSlotFills(compiled, fills).document;
    const tip = canonicalDocumentToEditorDocument(filled);
    expect(isValidDocStructure(tip)).toBe(true);
    expect(JSON.stringify(tip)).not.toContain('[unsupported');
    expect(nodeTypes(tip.content)).not.toContain('image');
    expect(hasType(tip.content, 'compositionHero')).toBe(true);
    expect(hasType(tip.content, 'heading')).toBe(true);
  });
});
