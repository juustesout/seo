/**
 * Representative document fixtures for the adapter tests.
 *
 * Two WordPress `post_content` articles (a full one exercising every supported
 * block plus unknown/freeform content, and a "representable" subset limited to
 * what the current Tiptap schema can express) and one Tiptap document using the
 * current editor schema. Kept as plain data so the same logical article can be
 * pushed through both formats.
 *
 * Test-only: nothing here is exported from the package barrel.
 */

import type { TipDoc } from './contentDoc.js';

/**
 * Full WordPress article: headings, paragraph with marks and a link, list,
 * quote, code, image, separator, nested group > columns > column, table,
 * unknown nested block, unknown void block, freeform HTML and inter-block
 * whitespace.
 */
export const wordpressArticleHtml = `<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Gadgets 101</h2>
<!-- /wp:heading -->

<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">Why gadgets matter</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Intro with <strong>bold</strong>, <em>italic</em> and <a href="https://ex.com/docs">a link</a>.</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>Alpha</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Beta</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:quote -->
<blockquote class="wp-block-quote"><!-- wp:paragraph -->
<p>Quoted wisdom.</p>
<!-- /wp:paragraph --></blockquote>
<!-- /wp:quote -->

<!-- wp:code {"language":"js"} -->
<pre class="wp-block-code"><code>const x = 1;</code></pre>
<!-- /wp:code -->

<!-- wp:image {"id":42,"width":640,"height":480} -->
<figure class="wp-block-image"><img src="https://cdn.ex.com/a.png" alt="A gadget" width="640" height="480"/><figcaption>A caption</figcaption></figure>
<!-- /wp:image -->

<!-- wp:separator -->
<hr class="wp-block-separator"/>
<!-- /wp:separator -->

<!-- wp:group {"layout":{"type":"constrained"}} -->
<div class="wp-block-group"><!-- wp:columns -->
<div class="wp-block-columns"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:paragraph -->
<p>Left column</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">Right column</h3>
<!-- /wp:heading --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></div>
<!-- /wp:group -->

<!-- wp:table -->
<figure class="wp-block-table"><table><tbody><!-- wp:table-row -->
<tr><!-- wp:table-cell -->
<td>One</td>
<!-- /wp:table-cell -->

<!-- wp:table-cell -->
<td>Two</td>
<!-- /wp:table-cell --></tr>
<!-- /wp:table-row --></tbody></table></figure>
<!-- /wp:table -->

<!-- wp:acme/widget {"label":"Callout","config":{"theme":"dark"}} -->
<div class="acme-widget"><!-- wp:paragraph -->
<p>Nested widget copy.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:acme/widget -->

<!-- wp:acme/badge {"text":"New"} /-->

<div class="legacy-callout">
  <p>Freeform HTML outside blocks.</p>
</div>`;

/**
 * The subset of {@link wordpressArticleHtml} whose content is representable in
 * both the canonical model and the current Tiptap schema, used for cross-format
 * semantic-equivalence checks.
 */
export const wordpressRepresentableHtml = `<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Gadgets 101</h2>
<!-- /wp:heading -->

<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">Why gadgets matter</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Intro with <strong>bold</strong>, <em>italic</em> and <a href="https://ex.com/docs">a link</a>.</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>Alpha</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Beta</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:quote -->
<blockquote class="wp-block-quote"><!-- wp:paragraph -->
<p>Quoted wisdom.</p>
<!-- /wp:paragraph --></blockquote>
<!-- /wp:quote -->

<!-- wp:code {"language":"js"} -->
<pre class="wp-block-code"><code>const x = 1;</code></pre>
<!-- /wp:code -->

<!-- wp:image {"id":42,"width":640,"height":480} -->
<figure class="wp-block-image"><img src="https://cdn.ex.com/a.png" alt="A gadget" width="640" height="480"/><figcaption>A caption</figcaption></figure>
<!-- /wp:image -->

<!-- wp:separator -->
<hr class="wp-block-separator"/>
<!-- /wp:separator -->`;

/**
 * Tiptap document using the current editor schema only: headings, paragraphs
 * with marks (bold/italic/strike/code/link), a hard break, bullet and ordered
 * lists (with `start`), a nested list, blockquote, code block, horizontal rule
 * and an image with the existing `ImageBlock` attributes.
 */
export function tiptapArticleDoc(): TipDoc {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Gadgets 101' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Intro with ' },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ', ' },
          { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
          { type: 'text', text: ', ' },
          { type: 'text', text: 'struck', marks: [{ type: 'strike' }] },
          { type: 'text', text: ', ' },
          { type: 'text', text: 'code', marks: [{ type: 'code' }] },
          { type: 'text', text: ' and ' },
          {
            type: 'text',
            text: 'a link',
            marks: [{ type: 'link', attrs: { href: 'https://ex.com/docs', target: '_blank', rel: 'noopener' } }],
          },
          { type: 'text', text: ' with a break after' },
          { type: 'hardBreak' },
          { type: 'text', text: 'second line.' },
        ],
      },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Why gadgets matter' }] },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] },
              {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha nested' }] }] }],
              },
            ],
          },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Beta' }] }] },
        ],
      },
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Third' }] }] }],
      },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted wisdom.' }] }] },
      { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const x = 1;' }] },
      { type: 'horizontalRule' },
      {
        type: 'image',
        attrs: { mediaId: 'm1', src: 'https://cdn.ex.com/a.png', alt: 'A gadget', caption: 'A caption', width: 640, height: 480 },
      },
    ],
  };
}
