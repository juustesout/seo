import { describe, expect, it } from 'vitest';
import {
  asContentBlocks,
  asTipDoc,
  docFromBlocks,
  docHeadings,
  docImages,
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

describe('media image nodes (phase F contracts)', () => {
  const image = {
    type: 'image',
    attrs: { mediaId: 'm-1', src: 'https://cdn.example/p/seo-media/p/1/x.png', alt: 'A red fox crossing a snowy field', caption: 'Fox', width: 800, height: 600 },
  } as const;
  const imgDoc: TipDoc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
      image,
      { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
    ],
  };

  it('accepts image leaf nodes carrying a mediaId', () => {
    expect(isValidDocStructure(imgDoc)).toBe(true);
  });

  it('rejects image nodes without a mediaId or with nested content', () => {
    expect(
      isValidDocStructure({ type: 'doc', content: [{ type: 'image', attrs: { src: 'x.png', alt: 'x' } }] }),
    ).toBe(false);
    expect(
      isValidDocStructure({ type: 'doc', content: [{ type: 'image', attrs: { mediaId: 'm', src: 5 } }] }),
    ).toBe(false);
  });

  it('renders a resolved figure with img, dimensions and figcaption', () => {
    const html = renderDocHtml(imgDoc).replace(/\n/g, '');
    expect(html).toContain(
      '<figure class="seo-media"><img src="https://cdn.example/p/seo-media/p/1/x.png" alt="A red fox crossing a snowy field" width="800" height="600" /><figcaption>Fox</figcaption>',
    );
  });

  it('renders an explicit placeholder instead of dropping an unresolvable reference', () => {
    const html = renderDocHtml({
      type: 'doc',
      content: [{ type: 'image', attrs: { mediaId: 'm-2', alt: 'Ghost' } }],
    });
    expect(html).toContain('data-image-missing="true"');
    expect(html).not.toContain('<img');
  });

  it('collects image references in document order via docImages', () => {
    expect(docImages(imgDoc)).toEqual([
      {
        mediaId: 'm-1',
        src: 'https://cdn.example/p/seo-media/p/1/x.png',
        alt: 'A red fox crossing a snowy field',
        caption: 'Fox',
        width: 800,
        height: 600,
      },
    ]);
  });

  it('maps image nodes to the legacy media content block shape', () => {
    const blocks = asContentBlocks(imgDoc);
    expect(blocks.find((b) => b.type === 'media')).toEqual({
      type: 'media',
      attrs: {
        kind: 'image',
        src: 'https://cdn.example/p/seo-media/p/1/x.png',
        alt: 'A red fox crossing a snowy field',
        caption: 'Fox',
      },
    });
  });
});
