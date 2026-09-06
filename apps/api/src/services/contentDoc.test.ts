import { describe, expect, it } from 'vitest';
import {
  asContentBlocks,
  asTipDoc,
  docFromBlocks,
  docHeadings,
  docPlainText,
  docWordCount,
  isValidDocStructure,
  renderDocHtml,
  tiptapEmptyDoc,
  type ContentBlock,
  type TipDoc,
} from '@seo/contracts';

const legacy: ContentBlock[] = [
  { type: 'heading', attrs: { level: 2, text: 'Intro' } },
  { type: 'paragraph', attrs: { text: 'Hello <world> & co.' } },
  { type: 'list', attrs: { ordered: false, items: ['a', 'b'] } },
  { type: 'quote', attrs: { text: 'q', cite: 'source' } },
  { type: 'code', attrs: { text: 'const x = 1' } },
  { type: 'media', attrs: { kind: 'placeholder', alt: 'hero' } },
  { type: 'link', attrs: { text: 'docs', href: 'https://example.com' } },
];

const sampleDoc: TipDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' world' },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
      ],
    },
    { type: 'codeBlock', content: [{ type: 'text', text: 'x=1' }] },
    { type: 'horizontalRule' },
  ],
};

describe('content doc model (contracts)', () => {
  it('accepts and rejects doc structure', () => {
    expect(isValidDocStructure(sampleDoc)).toBe(true);
    expect(isValidDocStructure(tiptapEmptyDoc())).toBe(true);
    expect(isValidDocStructure({ type: 'doc', content: [{ type: 'paragraph' }, { type: 'nope' }] })).toBe(false);
    expect(isValidDocStructure({ type: 'doc', content: [{ type: 'heading', content: [{ type: 'text', text: 'x' }] }] })).toBe(false);
    expect(isValidDocStructure({ type: 'notdoc', content: [] })).toBe(false);
  });

  it('renders a doc to html and escapes text', () => {
    const html = renderDocHtml(sampleDoc).replace(/\n/g, '');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<ul><li><p>a</p></li><li><p>b</p></li></ul>');
    expect(html).toContain('<pre><code>x=1</code></pre>');
    expect(html).toContain('<hr>');
    const esc = renderDocHtml({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '<tag> & text' }] }],
    });
    expect(esc).toContain('&lt;tag&gt; &amp; text');
  });

  it('extracts headings, plain text and word count from a doc', () => {
    expect(docHeadings(sampleDoc)).toEqual([{ level: 1, text: 'Title' }]);
    expect(docPlainText(sampleDoc)).toBe('Title\nHello bold world\na\nb\nx=1');
    expect(docWordCount(sampleDoc)).toBe(7);
  });

  it('converts legacy blocks to a doc and back with no fabrication', () => {
    const doc = docFromBlocks(legacy);
    expect(isValidDocStructure(doc)).toBe(true);
    const round = asContentBlocks(doc);
    expect(round).toEqual([
      { type: 'heading', attrs: { level: 2, text: 'Intro' } },
      { type: 'paragraph', attrs: { text: 'Hello <world> & co.' } },
      { type: 'list', attrs: { ordered: false, items: ['a', 'b'] } },
      { type: 'quote', attrs: { text: 'q' } },
      { type: 'code', attrs: { text: 'const x = 1' } },
      { type: 'paragraph', attrs: { text: 'docs' } },
    ]);
  });

  it('asTipDoc normalizes any stored value into a valid doc', () => {
    expect(asTipDoc(sampleDoc)).toBe(sampleDoc);
    expect(asTipDoc(legacy).type).toBe('doc');
    expect(asTipDoc('nonsense')).toEqual(tiptapEmptyDoc());
    expect(asTipDoc(null)).toEqual(tiptapEmptyDoc());
    expect(asContentBlocks(sampleDoc).length).toBeGreaterThan(0);
  });
});
