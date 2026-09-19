import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DOCUMENT_VERSION,
  CANONICAL_MAX_BLOCKS,
  canonicalBlockTypeOf,
  canonicalEmptyDoc,
  canonicalMarkTypeOf,
  isValidCanonicalDoc,
  withDesignSystemRef,
} from './canonical.js';

function validDoc(): unknown {
  return {
    version: CANONICAL_DOCUMENT_VERSION,
    meta: { title: 'Hello', language: 'en' },
    blocks: [
      {
        id: 'b0',
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Title', marks: [{ type: 'bold' }] }],
      },
      {
        id: 'b1',
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          {
            type: 'text',
            text: 'link',
            marks: [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank', rel: 'noopener' } }],
          },
          { type: 'break' },
          {
            type: 'inlineUnsupported',
            source: { cms: 'wordpress', type: 'core/emoji' },
            raw: '{"type":"emoji"}',
          },
        ],
      },
      {
        id: 'b2',
        type: 'list',
        attrs: { ordered: true, start: 1 },
        children: [
          {
            id: 'b2-0',
            type: 'listItem',
            children: [
              { id: 'b2-0-0', type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
            ],
          },
        ],
      },
      {
        id: 'b3',
        type: 'image',
        attrs: { mediaId: 'm1', src: 'https://cdn/x.png', alt: 'x', caption: 'cap', width: 100, height: 50 },
      },
      {
        id: 'b4',
        type: 'custom',
        source: {
          cms: 'wordpress',
          type: 'core/group',
          attrs: { layout: 'constrained' },
          innerContent: ['<div>', null, '</div>'],
        },
        children: [
          { id: 'b4-0', type: 'paragraph', content: [{ type: 'text', text: 'inner' }] },
        ],
      },
      { id: 'b5', type: 'html', rawHtml: '<div>raw</div>' },
    ],
  };
}

describe('canonicalEmptyDoc', () => {
  it('returns a v1 document with a single empty paragraph', () => {
    expect(canonicalEmptyDoc()).toEqual({
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [{ type: 'paragraph' }],
    });
  });

  it('passes validation', () => {
    expect(isValidCanonicalDoc(canonicalEmptyDoc())).toBe(true);
  });
});

describe('vocabulary helpers', () => {
  it('recognizes known block types and rejects unknown ones', () => {
    expect(canonicalBlockTypeOf('paragraph')).toBe(true);
    expect(canonicalBlockTypeOf('custom')).toBe(true);
    expect(canonicalBlockTypeOf('core/group')).toBe(false);
  });

  it('recognizes known mark types and rejects unknown ones', () => {
    expect(canonicalMarkTypeOf('bold')).toBe(true);
    expect(canonicalMarkTypeOf('link')).toBe(true);
    expect(canonicalMarkTypeOf('highlight')).toBe(false);
  });
});

describe('isValidCanonicalDoc', () => {
  it('accepts a realistic nested document', () => {
    expect(isValidCanonicalDoc(validDoc())).toBe(true);
  });

  it('does not mutate its input', () => {
    const doc = validDoc();
    const before = structuredClone(doc);
    expect(isValidCanonicalDoc(doc)).toBe(true);
    expect(doc).toEqual(before);
  });

  it('rejects non-objects', () => {
    expect(isValidCanonicalDoc(null)).toBe(false);
    expect(isValidCanonicalDoc(undefined)).toBe(false);
    expect(isValidCanonicalDoc('doc')).toBe(false);
    expect(isValidCanonicalDoc(42)).toBe(false);
    expect(isValidCanonicalDoc([])).toBe(false);
  });

  it('requires the current version', () => {
    expect(isValidCanonicalDoc({ version: 2, blocks: [] })).toBe(false);
    expect(isValidCanonicalDoc({ blocks: [] })).toBe(false);
  });

  it('requires a blocks array', () => {
    expect(isValidCanonicalDoc({ version: 1 })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: {} })).toBe(false);
  });

  it('rejects a block without a valid type', () => {
    expect(isValidCanonicalDoc({ version: 1, blocks: [{}] })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: '' }] })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 1 }] })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'has space' }] })).toBe(false);
  });

  it('accepts unknown semantic block types', () => {
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'somethingNew' }] })).toBe(true);
  });

  it('validates block ids', () => {
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ id: 'b0', type: 'paragraph' }] })).toBe(true);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ id: '-bad', type: 'paragraph' }] })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ id: 'a'.repeat(129), type: 'paragraph' }] })).toBe(false);
  });

  it('rejects malformed attrs', () => {
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'paragraph', attrs: [] }] })).toBe(false);
  });

  it('enforces heading levels', () => {
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'heading', attrs: { level: 1 } }] })).toBe(true);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'heading', attrs: { level: 6 } }] })).toBe(true);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'heading' }] })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'heading', attrs: { level: 0 } }] })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'heading', attrs: { level: 7 } }] })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'heading', attrs: { level: 2.5 } }] })).toBe(false);
  });

  it('enforces the list ordered/start attributes', () => {
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'list', attrs: { ordered: false } }] })).toBe(true);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'list', attrs: { ordered: true, start: 3 } }] })).toBe(true);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'list' }] })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'list', attrs: { ordered: 'yes' } }] })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'list', attrs: { ordered: true, start: 1.5 } }] })).toBe(false);
  });

  it('enforces image attribute types', () => {
    expect(
      isValidCanonicalDoc({
        version: 1,
        blocks: [{ type: 'image', attrs: { mediaId: 'm1', src: 's', alt: 'a', caption: 'c', width: 10, height: 20 } }],
      }),
    ).toBe(true);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'image', attrs: { mediaId: 1 } }] })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'image', attrs: { width: '10' } }] })).toBe(false);
  });

  it('validates inline text and marks', () => {
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] })).toBe(true);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'paragraph', content: [{ type: 'text' }] }] })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{}] }] }] })).toBe(false);
  });

  it('accepts break and unsupported inline escapes', () => {
    expect(isValidCanonicalDoc({ version: 1, blocks: [{ type: 'paragraph', content: [{ type: 'break' }] }] })).toBe(true);
    expect(
      isValidCanonicalDoc({
        version: 1,
        blocks: [{ type: 'paragraph', content: [{ type: 'inlineUnsupported', raw: '{}' }] }],
      }),
    ).toBe(true);
    expect(
      isValidCanonicalDoc({
        version: 1,
        blocks: [{ type: 'paragraph', content: [{ type: 'inlineUnsupported', raw: 5 }] }],
      }),
    ).toBe(false);
    expect(
      isValidCanonicalDoc({ version: 1, blocks: [{ type: 'paragraph', content: [{ type: 'nope' }] }] }),
    ).toBe(false);
  });

  it('requires a usable href on link marks', () => {
    const link = (attrs: unknown) => ({
      version: 1,
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs }] }] }],
    });
    expect(isValidCanonicalDoc(link({ href: 'https://example.com' }))).toBe(true);
    expect(isValidCanonicalDoc(link({}))).toBe(false);
    expect(isValidCanonicalDoc(link({ href: '' }))).toBe(false);
    expect(isValidCanonicalDoc(link({ href: '   ' }))).toBe(false);
    expect(isValidCanonicalDoc(link({ href: 'x'.repeat(4097) }))).toBe(false);
    expect(isValidCanonicalDoc(link({ href: 'https://x', target: 1 }))).toBe(false);
  });

  it('validates source envelopes', () => {
    const withSource = (source: unknown) => ({ version: 1, blocks: [{ type: 'custom', source }] });
    expect(isValidCanonicalDoc(withSource({ cms: 'wordpress' }))).toBe(true);
    expect(
      isValidCanonicalDoc(withSource({ cms: 'wordpress', type: 'core/group', attrs: { a: 1 }, innerContent: ['<a>', null] })),
    ).toBe(true);
    expect(isValidCanonicalDoc(withSource({ cms: '' }))).toBe(false);
    expect(isValidCanonicalDoc(withSource({ cms: 'WordPress' }))).toBe(false);
    expect(isValidCanonicalDoc(withSource({ cms: 'wp', attrs: [] }))).toBe(false);
    expect(isValidCanonicalDoc(withSource({ cms: 'wp', innerContent: ['a', 1] }))).toBe(false);
    expect(isValidCanonicalDoc(withSource({ cms: 'wp', attrsRaw: '{bad json}' }))).toBe(true);
    expect(isValidCanonicalDoc(withSource({ cms: 'wp', attrsRaw: '' }))).toBe(true);
    expect(isValidCanonicalDoc(withSource({ cms: 'wp', attrsRaw: 1 }))).toBe(false);
  });

  it('validates optional meta', () => {
    expect(isValidCanonicalDoc({ version: 1, blocks: [], meta: { title: 'T', language: null } })).toBe(true);
    expect(isValidCanonicalDoc({ version: 1, blocks: [], meta: {} })).toBe(true);
    expect(isValidCanonicalDoc({ version: 1, blocks: [], meta: { language: 1 } })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [], meta: { title: 1 } })).toBe(false);
    expect(isValidCanonicalDoc({ version: 1, blocks: [], meta: [] })).toBe(false);
  });

  it('rejects documents over the block budget', () => {
    const blocks = Array.from({ length: CANONICAL_MAX_BLOCKS + 1 }, () => ({ type: 'paragraph' }));
    expect(isValidCanonicalDoc({ version: 1, blocks })).toBe(false);
  });

  it('rejects documents nested beyond the depth budget', () => {
    let node: Record<string, unknown> = { type: 'paragraph' };
    for (let i = 0; i < 205; i += 1) node = { type: 'group', children: [node] };
    expect(isValidCanonicalDoc({ version: 1, blocks: [node] })).toBe(false);
  });
});

describe('withDesignSystemRef', () => {
  it('records a design-system reference without dropping existing meta', () => {
    const source = { ...canonicalEmptyDoc(), meta: { title: 'Hello', language: 'en' } };
    const stamped = withDesignSystemRef(source, { id: 'cosmos' });
    expect(stamped.meta).toEqual({ title: 'Hello', language: 'en', designSystem: { id: 'cosmos' } });
    expect(isValidCanonicalDoc(stamped)).toBe(true);
    expect(source.meta).toEqual({ title: 'Hello', language: 'en' });
  });

  it('returns the same document when there is no reference (default fallback)', () => {
    const source = canonicalEmptyDoc();
    expect(withDesignSystemRef(source, undefined)).toBe(source);
  });
});
