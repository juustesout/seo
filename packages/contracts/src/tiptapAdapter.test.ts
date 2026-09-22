import { describe, expect, it } from 'vitest';
import type { TipDoc } from './contentDoc.js';
import { tiptapEmptyDoc } from './contentDoc.js';
import type { CanonicalDocument } from './canonical.js';
import { CANONICAL_DOCUMENT_VERSION, isValidCanonicalDoc } from './canonical.js';
import { canonicalToTiptap, tiptapToCanonical } from './tiptapAdapter.js';

function richDoc(): TipDoc {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title', marks: [{ type: 'bold' }] }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world', marks: [{ type: 'italic' }] },
          { type: 'hardBreak' },
          { type: 'text', text: 'after', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
        ],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
              {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }] }],
              },
            ],
          },
        ],
      },
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }],
      },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quote' }] }] },
      { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const x = 1;' }] },
      { type: 'horizontalRule' },
      {
        type: 'image',
        attrs: { mediaId: 'm1', src: 'https://cdn/x.png', alt: 'x', caption: 'cap', width: 100, height: 50 },
      },
    ],
  };
}

describe('tiptapToCanonical', () => {
  it('produces a valid canonical document', () => {
    expect(isValidCanonicalDoc(tiptapToCanonical(richDoc()))).toBe(true);
  });

  it('maps known nodes onto semantic types', () => {
    const canonical = tiptapToCanonical(richDoc());
    const types = canonical.blocks.map((b) => b.type);
    expect(types).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'code', 'divider', 'image']);
    expect(canonical.blocks[0]?.attrs).toEqual({ level: 2 });
    expect(canonical.blocks[2]?.attrs).toEqual({ ordered: false });
    expect(canonical.blocks[3]?.attrs).toEqual({ ordered: true, start: 3 });
    expect(canonical.blocks[5]?.attrs).toEqual({ language: 'js' });
  });

  it('generates deterministic ids', () => {
    const first = tiptapToCanonical(richDoc());
    const second = tiptapToCanonical(richDoc());
    expect(first).toEqual(second);
    expect(first.blocks[0]?.id).toBe('b0');
    expect(first.blocks[1]?.id).toBe('b1');
    expect(first.blocks[2]?.children?.[0]?.id).toBe('b2-0');
  });

  it('does not mutate the input document', () => {
    const doc = richDoc();
    const before = structuredClone(doc);
    tiptapToCanonical(doc);
    expect(doc).toEqual(before);
  });

  it('maps an empty document to zero blocks', () => {
    expect(tiptapToCanonical({ type: 'doc' })).toEqual({ version: CANONICAL_DOCUMENT_VERSION, blocks: [] });
  });

  it('normalizes junk input to a single paragraph', () => {
    for (const junk of [null, undefined, 42, 'nope'] as unknown[]) {
      const canonical = tiptapToCanonical(junk);
      expect(canonical.blocks).toHaveLength(1);
      expect(canonical.blocks[0]?.type).toBe('paragraph');
    }
  });

  it('converts legacy block arrays through asTipDoc', () => {
    const canonical = tiptapToCanonical([
      { type: 'heading', attrs: { level: 2, text: 'H' } },
      { type: 'paragraph', attrs: { text: 'P' } },
    ]);
    expect(canonical.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph']);
  });

  it('carries unknown block nodes as custom with a lossless source', () => {
    const canonical = tiptapToCanonical({
      type: 'doc',
      content: [{ type: 'mention', attrs: { id: 'u1', label: 'Ana' } }],
    });
    expect(canonical.blocks[0]).toMatchObject({
      type: 'custom',
      source: { cms: 'tiptap', type: 'mention', attrs: { id: 'u1', label: 'Ana' } },
    });
  });

  it('carries unknown inline nodes as inlineUnsupported with raw JSON', () => {
    const canonical = tiptapToCanonical({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'hi ' },
            { type: 'emoji', attrs: { name: 'wave' } },
            { type: 'text', text: '!' },
          ],
        },
      ],
    });
    const inline = canonical.blocks[0]?.content?.[1];
    expect(inline?.type).toBe('inlineUnsupported');
    if (inline?.type === 'inlineUnsupported') {
      expect(inline.source).toEqual({ cms: 'tiptap', type: 'emoji', attrs: { name: 'wave' } });
      expect(inline.raw).toContain('"emoji"');
    }
  });
});

describe('tiptap round trip', () => {
  it('restores the rich document exactly', () => {
    const doc = richDoc();
    const canonical = tiptapToCanonical(doc);
    expect(canonicalToTiptap(canonical)).toEqual(doc);
  });

  it('restores unknown block nodes with their type and attrs', () => {
    const doc: TipDoc = {
      type: 'doc',
      content: [
        { type: 'mention', attrs: { id: 'u1', label: 'Ana' } },
        { type: 'mention', attrs: { id: 'u2' }, content: [{ type: 'text', text: '@ana' }] },
      ],
    };
    expect(canonicalToTiptap(tiptapToCanonical(doc))).toEqual(doc);
  });

  it('restores unknown inline nodes from their raw JSON', () => {
    const doc: TipDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'hi ' },
            { type: 'emoji', attrs: { name: 'wave' } },
            { type: 'text', text: '!' },
          ],
        },
      ],
    };
    expect(canonicalToTiptap(tiptapToCanonical(doc))).toEqual(doc);
  });

  it('keeps an empty article stable', () => {
    const doc = tiptapEmptyDoc();
    expect(canonicalToTiptap(tiptapToCanonical(doc))).toEqual(doc);
  });

  it('keeps a paragraph-only image document stable', () => {
    const doc: TipDoc = { type: 'doc', content: [{ type: 'image', attrs: { mediaId: 'm1' } }, { type: 'paragraph' }] };
    expect(canonicalToTiptap(tiptapToCanonical(doc))).toEqual(doc);
  });

  it('omits an unset image width/height instead of emitting invalid nulls', () => {
    const doc: TipDoc = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: { mediaId: 'm1', src: 'https://cdn/x.png', alt: '', caption: '', width: null, height: null },
        },
      ],
    };
    const canonical = tiptapToCanonical(doc);
    expect(canonical.blocks[0]?.attrs).toEqual({
      mediaId: 'm1',
      src: 'https://cdn/x.png',
      alt: '',
      caption: '',
    });
    expect(isValidCanonicalDoc(canonical)).toBe(true);
  });
});

describe('canonicalToTiptap', () => {
  it('emits an empty doc for a blockless document', () => {
    expect(canonicalToTiptap({ version: CANONICAL_DOCUMENT_VERSION, blocks: [] })).toEqual({ type: 'doc' });
  });

  it('flattens blocks TipTap cannot represent without dropping their content', () => {
    const canonical: CanonicalDocument = {
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [
        {
          type: 'table',
          children: [
            { type: 'tableRow', children: [{ type: 'tableCell', content: [{ type: 'text', text: 'cell' }] }] },
          ],
        },
        { type: 'html', rawHtml: '<b>x</b>' },
      ],
    };
    expect(isValidCanonicalDoc(canonical)).toBe(true);
    expect(canonicalToTiptap(canonical)).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'cell' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '<b>x</b>' }] },
      ],
    });
  });

  it('flattens non-TipTap custom blocks but keeps their children', () => {
    const canonical: CanonicalDocument = {
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [
        {
          type: 'custom',
          source: { cms: 'wordpress', type: 'core/group' },
          children: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }],
        },
      ],
    };
    expect(canonicalToTiptap(canonical)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }],
    });
  });

  it('emits an explicit marker for a block with nothing TipTap can represent', () => {
    const canonical: CanonicalDocument = {
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [{ type: 'custom', source: { cms: 'wordpress', type: 'acme/badge', attrs: { text: 'New' } } }],
    };
    expect(canonicalToTiptap(canonical)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '[unsupported:acme/badge]' }] }],
    });
  });

  it('clamps out-of-range heading levels rather than dropping the block', () => {
    const canonical: CanonicalDocument = {
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [{ type: 'heading', attrs: { level: 99 } }],
    };
    expect(canonicalToTiptap(canonical)).toEqual({ type: 'doc', content: [{ type: 'heading', attrs: { level: 6 } }] });
  });

  it('preserves an ordered list start value', () => {
    const canonical: CanonicalDocument = {
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [
        {
          type: 'list',
          attrs: { ordered: true, start: 5 },
          children: [{ type: 'listItem', children: [{ type: 'paragraph' }] }],
        },
      ],
    };
    expect(canonicalToTiptap(canonical)).toEqual({
      type: 'doc',
      content: [
        { type: 'orderedList', attrs: { start: 5 }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
      ],
    });
  });
});
