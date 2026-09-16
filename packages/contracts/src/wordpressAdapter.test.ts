import { describe, expect, it } from 'vitest';
import type { CanonicalBlock, CanonicalDocument, CanonicalInline } from './canonical.js';
import { CANONICAL_DOCUMENT_VERSION, isValidCanonicalDoc } from './canonical.js';
import {
  WordPressAdapterError,
  parseWordPressBlocks,
  serializeWordPressBlocks,
  WORDPRESS_MAX_ATTRIBUTES_CHARS,
  WORDPRESS_MAX_INPUT_CHARS,
} from './wordpressAdapter.js';

const POST_CONTENT = `<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Gadgets 101</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Intro with <strong>bold</strong>, <em>italic</em> and <a href="https://ex.com">a link</a>.</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>One</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Two</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:image {"id":42,"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="https://cdn.ex.com/a.jpg" alt="A"/><figcaption>Cap</figcaption></figure>
<!-- /wp:image -->

<!-- wp:quote -->
<blockquote class="wp-block-quote"><!-- wp:paragraph -->
<p>Quoted.</p>
<!-- /wp:paragraph --></blockquote>
<!-- /wp:quote -->

<!-- wp:group {"layout":{"type":"constrained"}} -->
<div class="wp-block-group"><!-- wp:columns -->
<div class="wp-block-columns"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:paragraph -->
<p>Left</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">Right</h3>
<!-- /wp:heading --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></div>
<!-- /wp:group -->

<p>Raw freeform HTML.</p>

<!-- wp:acme/widget {"foo":1,"bar":"x"} -->
<div class="acme-widget">Custom</div>
<!-- /wp:acme/widget -->

<!-- wp:separator {"className":"is-style-wide"} /-->`;

function roundTrip(html: string): string {
  return serializeWordPressBlocks(parseWordPressBlocks(html));
}

function findText(content: CanonicalInline[] | undefined, text: string): Extract<CanonicalInline, { type: 'text' }> | undefined {
  return content?.find((node): node is Extract<CanonicalInline, { type: 'text' }> => node.type === 'text' && node.text === text);
}

/** Strips the lossless origin envelope so two documents can be compared on
 *  their semantic projection alone. */
function semantic(block: CanonicalBlock): unknown {
  return {
    type: block.type,
    attrs: block.attrs,
    content: block.content,
    children: block.children?.map(semantic),
    rawHtml: block.rawHtml,
  };
}

function semanticDoc(doc: CanonicalDocument): unknown[] {
  return doc.blocks.map(semantic);
}

describe('parseWordPressBlocks / serializeWordPressBlocks', () => {
  it('round-trips an empty document', () => {
    expect(parseWordPressBlocks('')).toEqual({ version: CANONICAL_DOCUMENT_VERSION, blocks: [] });
    expect(serializeWordPressBlocks({ version: CANONICAL_DOCUMENT_VERSION, blocks: [] })).toBe('');
  });

  it('parses and round-trips a single paragraph', () => {
    const html = '<!-- wp:paragraph -->\n<p>Hello world.</p>\n<!-- /wp:paragraph -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.type).toBe('paragraph');
    expect(findText(doc.blocks[0]?.content, 'Hello world.')).toBeDefined();
    expect(roundTrip(html)).toBe(html);
  });

  it('parses a heading with attributes', () => {
    const html = '<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">Title</h3>\n<!-- /wp:heading -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('heading');
    expect(doc.blocks[0]?.attrs).toEqual({ level: 3 });
    expect(doc.blocks[0]?.source?.type).toBe('core/heading');
    expect(doc.blocks[0]?.source?.attrs).toEqual({ level: 3 });
    expect(findText(doc.blocks[0]?.content, 'Title')).toBeDefined();
    expect(roundTrip(html)).toBe(html);
  });

  it('parses bold, italic and link marks', () => {
    const html =
      '<!-- wp:paragraph -->\n<p>Intro <strong>bold</strong> and <em>italic</em> plus <a href="https://ex.com">link</a>.</p>\n<!-- /wp:paragraph -->';
    const doc = parseWordPressBlocks(html);
    expect(findText(doc.blocks[0]?.content, 'bold')?.marks).toEqual([{ type: 'bold' }]);
    expect(findText(doc.blocks[0]?.content, 'italic')?.marks).toEqual([{ type: 'italic' }]);
    expect(findText(doc.blocks[0]?.content, 'link')?.marks).toEqual([
      { type: 'link', attrs: { href: 'https://ex.com' } },
    ]);
    expect(roundTrip(html)).toBe(html);
  });

  it('parses a nested group', () => {
    const html =
      '<!-- wp:group {"layout":{"type":"constrained"}} -->\n<div class="wp-block-group"><!-- wp:paragraph -->\n<p>Inside.</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:group -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('group');
    expect(doc.blocks[0]?.children?.[0]?.type).toBe('paragraph');
    expect(doc.blocks[0]?.source?.type).toBe('core/group');
    expect(roundTrip(html)).toBe(html);
  });

  it('parses columns -> column -> content', () => {
    const html =
      '<!-- wp:columns -->\n<div class="wp-block-columns"><!-- wp:column -->\n<div class="wp-block-column"><!-- wp:paragraph -->\n<p>Left</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:column --></div>\n<!-- /wp:columns -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('columns');
    expect(doc.blocks[0]?.children?.[0]?.type).toBe('column');
    expect(doc.blocks[0]?.children?.[0]?.children?.[0]?.type).toBe('paragraph');
    expect(roundTrip(html)).toBe(html);
  });

  it('parses modern list-item blocks and derives ordered', () => {
    const html =
      '<!-- wp:list {"ordered":true} -->\n<ol class="wp-block-list"><!-- wp:list-item -->\n<li>A</li>\n<!-- /wp:list-item --></ol>\n<!-- /wp:list -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('list');
    expect(doc.blocks[0]?.attrs).toEqual({ ordered: true });
    expect(doc.blocks[0]?.children?.[0]?.type).toBe('listItem');
    expect(roundTrip(html)).toBe(html);
  });

  it('parses plain <ul>/<li> lists without nested blocks', () => {
    const html = '<!-- wp:list -->\n<ul><li>One</li><li>Two</li></ul>\n<!-- /wp:list -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.attrs).toEqual({ ordered: false });
    expect(doc.blocks[0]?.children?.map((c) => c.type)).toEqual(['listItem', 'listItem']);
    expect(findText(doc.blocks[0]?.children?.[0]?.content, 'One')).toBeDefined();
    expect(roundTrip(html)).toBe(html);
  });

  it('parses a quote', () => {
    const html =
      '<!-- wp:quote -->\n<blockquote class="wp-block-quote"><!-- wp:paragraph -->\n<p>Quoted.</p>\n<!-- /wp:paragraph --></blockquote>\n<!-- /wp:quote -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('quote');
    expect(doc.blocks[0]?.children?.[0]?.type).toBe('paragraph');
    expect(roundTrip(html)).toBe(html);
  });

  it('parses a code block', () => {
    const html = '<!-- wp:code -->\n<pre class="wp-block-code"><code>const x = 1;\n</code></pre>\n<!-- /wp:code -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('code');
    expect(findText(doc.blocks[0]?.content, 'const x = 1;\n')).toBeDefined();
    expect(roundTrip(html)).toBe(html);
  });

  it('parses an image with attributes', () => {
    const html =
      '<!-- wp:image {"id":42,"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="https://cdn.ex.com/a.jpg" alt="A"/><figcaption>Cap</figcaption></figure>\n<!-- /wp:image -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('image');
    expect(doc.blocks[0]?.attrs).toEqual({
      mediaId: '42',
      src: 'https://cdn.ex.com/a.jpg',
      alt: 'A',
      caption: 'Cap',
    });
    expect(roundTrip(html)).toBe(html);
  });

  it('parses a separator (self-closing block)', () => {
    const html = '<!-- wp:separator {"className":"is-style-wide"} /-->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('divider');
    expect(doc.blocks[0]?.source?.attrs).toEqual({ className: 'is-style-wide' });
    expect(roundTrip(html)).toBe(html);
  });

  it('parses a table hierarchy', () => {
    const html = `<!-- wp:table -->
<figure class="wp-block-table"><table><tbody><!-- wp:table-row -->
<tr><!-- wp:table-cell -->
<td>A</td>
<!-- /wp:table-cell -->

<!-- wp:table-cell -->
<td>B</td>
<!-- /wp:table-cell --></tr>
<!-- /wp:table-row --></tbody></table></figure>
<!-- /wp:table -->`;
    const doc = parseWordPressBlocks(html);
    const table = doc.blocks[0];
    expect(table?.type).toBe('table');
    expect(table?.children?.[0]?.type).toBe('tableRow');
    expect(table?.children?.[0]?.children?.map((c) => c.type)).toEqual(['tableCell', 'tableCell']);
    expect(findText(table?.children?.[0]?.children?.[1]?.content, 'B')).toBeDefined();
    expect(roundTrip(html)).toBe(html);
  });

  it('keeps unknown blocks as custom with their WordPress identity', () => {
    const html =
      '<!-- wp:acme/widget {"foo":1} -->\n<div class="acme-widget">Custom</div>\n<!-- /wp:acme/widget -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('custom');
    expect(doc.blocks[0]?.source?.type).toBe('acme/widget');
    expect(doc.blocks[0]?.source?.attrs).toEqual({ foo: 1 });
    expect(doc.blocks[0]?.attrs).toEqual({ foo: 1 });
    expect(roundTrip(html)).toBe(html);
  });

  it('keeps an unknown self-closing block', () => {
    const html = '<!-- wp:acme/thing {"a":1} /-->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('custom');
    expect(doc.blocks[0]?.source?.type).toBe('acme/thing');
    expect(roundTrip(html)).toBe(html);
  });

  it('retains the body of a childless custom block as rawHtml', () => {
    const html = '<!-- wp:acme/widget {"foo":1} -->\n<div class="acme-widget">Custom body</div>\n<!-- /wp:acme/widget -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('custom');
    expect(doc.blocks[0]?.children).toBeUndefined();
    expect(doc.blocks[0]?.rawHtml).toContain('Custom body');
    expect(roundTrip(html)).toBe(html);
  });

  it('renders semantic attributes for code and list without a WordPress source', () => {
    const doc: CanonicalDocument = {
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [
        { type: 'code', attrs: { language: 'js' }, content: [{ type: 'text', text: 'x' }] },
        {
          type: 'list',
          attrs: { ordered: true, start: 3 },
          children: [{ type: 'listItem', content: [{ type: 'text', text: 'a' }] }],
        },
      ],
    };
    const html = serializeWordPressBlocks(doc);
    expect(html).toContain('<!-- wp:code {"language":"js"} -->');
    expect(html).toContain('"ordered":true');
    expect(html).toContain('"start":3');
    expect(semanticDoc(parseWordPressBlocks(html))).toEqual(semanticDoc(doc));
  });

  it('does not fabricate a WordPress attachment id from an opaque mediaId', () => {
    const doc: CanonicalDocument = {
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [{ type: 'image', attrs: { mediaId: 'm1', src: 's.png', alt: 'a', width: 10, height: 20 } }],
    };
    const html = serializeWordPressBlocks(doc);
    expect(html).not.toContain('"id"');
    expect(html).not.toContain('mediaId');
    expect(html).toContain('src="s.png"');
    expect(html).toContain('width="10"');
    const back = parseWordPressBlocks(html).blocks[0];
    expect(back?.attrs).toEqual({ src: 's.png', alt: 'a', width: 10, height: 20 });
    expect(back?.attrs?.mediaId).toBeUndefined();
  });

  it('preserves a WordPress-origin attachment id through the source envelope', () => {
    const html =
      '<!-- wp:image {"id":12345,"width":640,"height":480} -->\n<figure class="wp-block-image"><img src="https://cdn.ex.com/a.png" alt="A" width="640" height="480"/></figure>\n<!-- /wp:image -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.attrs?.mediaId).toBe('12345');
    expect(doc.blocks[0]?.source?.attrs).toEqual({ id: 12345, width: 640, height: 480 });
    expect(serializeWordPressBlocks(doc)).toBe(html);
  });

  it('preserves freeform HTML between blocks', () => {
    const html =
      '<!-- wp:paragraph -->\n<p>A</p>\n<!-- /wp:paragraph -->\n\n<p>Raw</p>\n\n<!-- wp:paragraph -->\n<p>B</p>\n<!-- /wp:paragraph -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks.map((b) => b.type)).toEqual(['paragraph', 'html', 'paragraph']);
    expect(doc.blocks[1]?.rawHtml).toContain('<p>Raw</p>');
    expect(roundTrip(html)).toBe(html);
  });

  it('preserves raw HTML content verbatim', () => {
    const html = '<div data-x="1">\n  <script>const y = 2;</script>\n</div>';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.type).toBe('html');
    expect(doc.blocks[0]?.rawHtml).toBe(html);
    expect(roundTrip(html)).toBe(html);
  });

  it('keeps a nested unknown block with its known child', () => {
    const html =
      '<!-- wp:acme/widget {"foo":1} -->\n<div class="acme-widget"><!-- wp:paragraph -->\n<p>Inner</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:acme/widget -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('custom');
    expect(doc.blocks[0]?.children?.[0]?.type).toBe('paragraph');
    expect(roundTrip(html)).toBe(html);
  });

  it('tolerates malformed block attribute JSON and preserves the raw payload', () => {
    const html = '<!-- wp:paragraph {bad json} -->\n<p>Text</p>\n<!-- /wp:paragraph -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('paragraph');
    expect(doc.blocks[0]?.source?.attrs).toBeUndefined();
    expect(doc.blocks[0]?.source?.attrsRaw).toBe('{bad json}');
    expect(findText(doc.blocks[0]?.content, 'Text')).toBeDefined();
    expect(isValidCanonicalDoc(doc)).toBe(true);
    expect(roundTrip(html)).toBe(html);
  });

  it('preserves raw attribute text verbatim across a round trip', () => {
    const html = '<!-- wp:group {  "a": 1 ,"b":[2, 3] } -->\n<div class="wp-block-group"><!-- wp:paragraph -->\n<p>x</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:group -->';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.source?.attrsRaw).toBe('{  "a": 1 ,"b":[2, 3] }');
    expect(roundTrip(html)).toBe(html);
  });

  it('tolerates an unclosed block comment', () => {
    const html = '<!-- wp:paragraph -->\n<p>No closer</p>';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks[0]?.type).toBe('paragraph');
    expect(findText(doc.blocks[0]?.content, 'No closer')).toBeDefined();
  });

  it('treats a stray closer as freeform HTML', () => {
    const html = '<p>lead</p>\n<!-- /wp:paragraph -->\n<p>after</p>';
    const doc = parseWordPressBlocks(html);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.type).toBe('html');
    expect(doc.blocks[0]?.rawHtml).toBe(html);
    expect(roundTrip(html)).toBe(html);
  });

  it('serializes deterministically', () => {
    const a = serializeWordPressBlocks(parseWordPressBlocks(POST_CONTENT));
    const b = serializeWordPressBlocks(parseWordPressBlocks(POST_CONTENT));
    expect(a).toBe(b);
  });

  it('round-trips a representative WordPress post_content byte-for-byte', () => {
    const doc = parseWordPressBlocks(POST_CONTENT);
    expect(isValidCanonicalDoc(doc)).toBe(true);
    expect(serializeWordPressBlocks(doc)).toBe(POST_CONTENT);
  });

  it('keeps canonical -> WordPress -> canonical semantic equivalence', () => {
    const doc: CanonicalDocument = {
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world', marks: [{ type: 'bold' }] },
          ],
        },
        { type: 'list', attrs: { ordered: false }, children: [{ type: 'listItem', content: [{ type: 'text', text: 'One' }] }] },
        { type: 'image', attrs: { src: 'https://x/a.png', alt: 'A', caption: 'Cap' } },
        { type: 'group', children: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inner' }] }] },
        { type: 'divider' },
      ],
    };
    const back = parseWordPressBlocks(serializeWordPressBlocks(doc));
    expect(semanticDoc(back)).toEqual(semanticDoc(doc));
  });
});

describe('wordpress adapter safety bounds', () => {
  it('throws a structured error when the input is too large', () => {
    const huge = 'a'.repeat(WORDPRESS_MAX_INPUT_CHARS + 1);
    expect(() => parseWordPressBlocks(huge)).toThrow(WordPressAdapterError);
    try {
      parseWordPressBlocks(huge);
    } catch (error) {
      expect((error as WordPressAdapterError).code).toBe('input_too_large');
    }
  });

  it('throws a structured error when an attribute object is too large', () => {
    const attrs = `{"data":"${'x'.repeat(WORDPRESS_MAX_ATTRIBUTES_CHARS)}"}`;
    const html = `<!-- wp:paragraph ${attrs} -->\n<p>x</p>\n<!-- /wp:paragraph -->`;
    try {
      parseWordPressBlocks(html);
      throw new Error('expected parse to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WordPressAdapterError);
      expect((error as WordPressAdapterError).code).toBe('attributes_too_large');
    }
  });

  it('throws a structured error when nesting is too deep', () => {
    let html = '';
    for (let i = 0; i < 205; i += 1) html += '<!-- wp:group -->\n<div class="wp-block-group">';
    html += '<!-- wp:paragraph -->\n<p>x</p>\n<!-- /wp:paragraph -->';
    for (let i = 0; i < 205; i += 1) html += '</div>\n<!-- /wp:group -->';
    try {
      parseWordPressBlocks(html);
      throw new Error('expected parse to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WordPressAdapterError);
      expect((error as WordPressAdapterError).code).toBe('max_depth_exceeded');
    }
  });
});
