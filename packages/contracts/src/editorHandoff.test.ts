import { describe, expect, it } from 'vitest';
import type { CanonicalBlock, CanonicalDocument } from './canonical.js';
import { CANONICAL_DOCUMENT_VERSION } from './canonical.js';
import { canonicalDocumentToEditorDocument } from './editorHandoff.js';
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

function nodeTypes(nodes: TipNode[] | undefined): string[] {
  return (nodes ?? []).map((node) => node.type);
}

function firstOfType(docValue: ReturnType<typeof canonicalDocumentToEditorDocument>, type: string): TipNode | undefined {
  return (docValue.content ?? []).find((node) => node.type === type);
}

function textOf(node: TipNode | undefined): string {
  return (node?.content ?? []).map((child) => child.text ?? '').join('');
}

describe('canonicalDocumentToEditorDocument content mapping', () => {
  it('maps headings with their level and paragraphs with their text', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        text('Body copy'),
      ]),
    );
    const heading = firstOfType(tip, 'heading');
    expect((heading?.attrs as { level?: number } | undefined)?.level).toBe(1);
    expect(textOf(heading)).toBe('Title');
    expect(textOf(firstOfType(tip, 'paragraph'))).toBe('Body copy');
  });

  it('keeps multiple sections in document order', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([
        { type: 'section', children: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'One' }] }] },
        { type: 'section', children: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Two' }] }] },
      ]),
    );
    const headings = (tip.content ?? []).filter((node) => node.type === 'heading');
    expect(headings.map(textOf)).toEqual(['One', 'Two']);
  });

  it('flattens feature grids and cards into their heading and body content', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([
        {
          type: 'featureGrid',
          attrs: { layout: { columns: 3 } },
          children: [
            {
              type: 'featureCard',
              attrs: { variant: 'elevated' },
              children: [
                { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Fast' }] },
                text('Ship quickly.'),
              ],
            },
          ],
        },
      ]),
    );
    expect(nodeTypes(tip.content)).toEqual(['heading', 'paragraph']);
    expect(textOf(tip.content?.[0])).toBe('Fast');
    expect(textOf(tip.content?.[1])).toBe('Ship quickly.');
  });

  it('turns CTA button copy into a paragraph instead of an unsupported marker', () => {
    const tip = canonicalDocumentToEditorDocument(
      doc([
        {
          type: 'cta',
          attrs: { variant: 'primary' },
          children: [{ type: 'button', attrs: { variant: 'primary' }, content: [{ type: 'text', text: 'Get started' }] }],
        },
      ]),
    );
    expect(nodeTypes(tip.content)).toEqual(['paragraph']);
    expect(textOf(tip.content?.[0])).toBe('Get started');
    expect(JSON.stringify(tip)).not.toContain('[unsupported');
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
        children: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
          { type: 'image' },
          { type: 'button', content: [{ type: 'text', text: 'Go' }] },
        ],
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
    expect(tip.content?.some((node) => node.type === 'heading')).toBe(true);
  });
});
