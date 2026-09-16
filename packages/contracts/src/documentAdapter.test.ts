import { describe, expect, it } from 'vitest';
import type { CanonicalBlock, CanonicalDocument } from './canonical.js';
import { isValidCanonicalDoc } from './canonical.js';
import type { TipDoc, TipNode } from './contentDoc.js';
import { isValidDocStructure } from './contentDoc.js';
import { canonicalToTiptap, tiptapToCanonical } from './tiptapAdapter.js';
import {
  canonicalToTiptap as directCanonicalToTiptap,
  tiptapToCanonical as directTiptapToCanonical,
} from './tiptapAdapter.js';
import {
  WordPressAdapterError,
  parseWordPressBlocks,
  serializeWordPressBlocks,
  WORDPRESS_MAX_INPUT_CHARS,
} from './wordpressAdapter.js';
import {
  canonicalToWordPress,
  tiptapToWordPress,
  wordpressToCanonical,
  wordpressToTipTap,
} from './documentAdapter.js';
import {
  tiptapArticleDoc,
  wordpressArticleHtml,
  wordpressRepresentableHtml,
} from './documentFixtures.js';

// ---------------------------------------------------------------------------
// Test-only normalization / comparison helpers (never used in production).
// ---------------------------------------------------------------------------

/** Drops the lossless `source` envelope and an opaque image `mediaId` so two
 *  documents compare on their semantic projection, modulo the reference the
 *  pure WordPress adapter cannot resolve. */
function semanticNoMedia(block: CanonicalBlock): unknown {
  const attrs = block.attrs ? { ...block.attrs } : undefined;
  if (attrs) delete attrs.mediaId;
  return {
    type: block.type,
    attrs,
    content: block.content,
    children: block.children?.map(semanticNoMedia),
    rawHtml: block.rawHtml,
  };
}

function semanticBlocksNoMedia(doc: CanonicalDocument): unknown[] {
  return doc.blocks.map(semanticNoMedia);
}

/** The same TipTap document with image `mediaId` removed, for comparisons that
 *  cross the provider-resolution boundary. */
function withoutMediaIds(doc: TipDoc): TipDoc {
  const clean = (node: TipNode): TipNode => {
    const next: TipNode = { ...node };
    if (node.content) next.content = node.content.map(clean);
    if (node.type === 'image' && next.attrs) {
      const attrs = { ...next.attrs };
      delete attrs.mediaId;
      next.attrs = attrs;
    }
    return next;
  };
  return { ...doc, content: (doc.content ?? []).map(clean) };
}

function allText(doc: CanonicalDocument): string[] {
  const out: string[] = [];
  const walk = (block: CanonicalBlock): void => {
    for (const inline of block.content ?? []) {
      if (inline.type === 'text') out.push(inline.text);
    }
    for (const child of block.children ?? []) walk(child);
  };
  for (const block of doc.blocks) walk(block);
  return out;
}

function findAllNodes(doc: TipDoc, type: string): TipNode[] {
  const out: TipNode[] = [];
  const walk = (nodes: TipNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (node.type === type) out.push(node);
      walk(node.content);
    }
  };
  walk(doc.content);
  return out;
}

// ---------------------------------------------------------------------------

describe('wordpressToCanonical / canonicalToWordPress', () => {
  it('delegates to the WordPress adapter without re-implementing it', () => {
    expect(wordpressToCanonical(wordpressArticleHtml)).toEqual(parseWordPressBlocks(wordpressArticleHtml));
    const doc = wordpressToCanonical(wordpressArticleHtml);
    expect(canonicalToWordPress(doc)).toBe(serializeWordPressBlocks(doc));
  });

  it('parses a representative article into a valid canonical document', () => {
    const doc = wordpressToCanonical(wordpressArticleHtml);
    expect(isValidCanonicalDoc(doc)).toBe(true);
    expect(doc.blocks.map((b) => b.type).filter((type) => type !== 'html')).toEqual([
      'heading',
      'heading',
      'paragraph',
      'list',
      'quote',
      'code',
      'image',
      'divider',
      'group',
      'table',
      'custom',
      'custom',
    ]);
    expect(doc.blocks.at(-1)?.type).toBe('html');
    expect(doc.blocks.at(-1)?.rawHtml).toContain('Freeform HTML outside blocks.');
  });

  it('round-trips WordPress byte-for-byte and deterministically', () => {
    const doc = wordpressToCanonical(wordpressArticleHtml);
    expect(canonicalToWordPress(doc)).toBe(wordpressArticleHtml);
    expect(canonicalToWordPress(wordpressToCanonical(wordpressArticleHtml))).toBe(
      canonicalToWordPress(wordpressToCanonical(wordpressArticleHtml)),
    );
  });

  it('propagates the WordPress safety bounds instead of truncating', () => {
    expect(() => wordpressToCanonical('a'.repeat(WORDPRESS_MAX_INPUT_CHARS + 1))).toThrow(WordPressAdapterError);
    expect(() => wordpressToTipTap('a'.repeat(WORDPRESS_MAX_INPUT_CHARS + 1))).toThrow(WordPressAdapterError);
  });
});

describe('tiptapToCanonical / canonicalToTiptap re-exports', () => {
  it('exposes the existing Stage 1 adapter bindings, not copies', () => {
    expect(tiptapToCanonical).toBe(directTiptapToCanonical);
    expect(canonicalToTiptap).toBe(directCanonicalToTiptap);
  });
});

describe('wordpressToTipTap', () => {
  it('produces an editor-valid Tiptap document for the full article', () => {
    const doc = wordpressToTipTap(wordpressArticleHtml);
    expect(isValidDocStructure(doc)).toBe(true);
  });

  it('preserves headings, marks, links and block types', () => {
    const doc = wordpressToTipTap(wordpressRepresentableHtml);
    expect(isValidDocStructure(doc)).toBe(true);
    expect(findAllNodes(doc, 'heading').map((n) => n.attrs?.level)).toEqual([2, 3]);

    const paragraph = findAllNodes(doc, 'paragraph').find((n) =>
      (n.content ?? []).some((c) => c.text === 'bold'),
    );
    const markTypes = (paragraph?.content ?? []).flatMap((c) => (c.marks ?? []).map((m) => m.type));
    expect(markTypes).toContain('bold');
    expect(markTypes).toContain('italic');
    expect((paragraph?.content ?? []).find((c) => c.text === 'a link')?.marks).toEqual([
      { type: 'link', attrs: { href: 'https://ex.com/docs' } },
    ]);

    expect(findAllNodes(doc, 'bulletList')).toHaveLength(1);
    expect(findAllNodes(doc, 'blockquote')).toHaveLength(1);
    expect(findAllNodes(doc, 'codeBlock')[0]?.attrs).toEqual({ language: 'js' });
    expect(findAllNodes(doc, 'horizontalRule')).toHaveLength(1);
  });

  it('preserves image attributes, including the media reference', () => {
    const image = findAllNodes(wordpressToTipTap(wordpressArticleHtml), 'image')[0];
    expect(image?.attrs).toEqual({
      mediaId: '42',
      src: 'https://cdn.ex.com/a.png',
      alt: 'A gadget',
      caption: 'A caption',
      width: 640,
      height: 480,
    });
  });

  it('carries an ordered list start value through', () => {
    const html =
      '<!-- wp:list {"ordered":true,"start":3} -->\n<ol class="wp-block-list"><!-- wp:list-item -->\n<li>Third</li>\n<!-- /wp:list-item --></ol>\n<!-- /wp:list -->';
    const list = findAllNodes(wordpressToTipTap(html), 'orderedList')[0];
    expect(list?.attrs).toEqual({ start: 3 });
  });

  it('flattens structures Tiptap cannot represent but keeps their content', () => {
    const raw = JSON.stringify(wordpressToTipTap(wordpressArticleHtml));
    // group > columns > column
    expect(raw).toContain('Left column');
    expect(raw).toContain('Right column');
    // table cells
    expect(raw).toContain('One');
    expect(raw).toContain('Two');
    // unknown nested block child
    expect(raw).toContain('Nested widget copy.');
    // freeform HTML survives as visible text
    expect(raw).toContain('<p>Freeform HTML outside blocks.</p>');
  });

  it('marks an unknown block with nothing representable instead of dropping it', () => {
    expect(JSON.stringify(wordpressToTipTap(wordpressArticleHtml))).toContain('[unsupported:acme/badge]');
  });

  it('never loses text that the canonical document carries', () => {
    const canonical = wordpressToCanonical(wordpressArticleHtml);
    const tipTapJson = JSON.stringify(wordpressToTipTap(wordpressArticleHtml));
    for (const text of allText(canonical)) {
      expect(tipTapJson).toContain(text);
    }
  });
});

describe('tiptapToWordPress', () => {
  it('emits WordPress block markup and parses back to the same semantics', () => {
    const doc = tiptapArticleDoc();
    const html = tiptapToWordPress(doc);
    expect(html).toContain('<!-- wp:heading {"level":2} -->');
    expect(html).toContain('<!-- wp:list');
    expect(html).toContain('<!-- wp:code {"language":"js"} -->');
    expect(html).toContain('<!-- wp:separator /-->');

    const back = parseWordPressBlocks(html);
    expect(isValidCanonicalDoc(back)).toBe(true);
    expect(semanticBlocksNoMedia(back)).toEqual(semanticBlocksNoMedia(tiptapToCanonical(doc)));
  });

  it('emits unknown Tiptap nodes as WordPress custom blocks', () => {
    const html = tiptapToWordPress({ type: 'doc', content: [{ type: 'mention', attrs: { id: 'u1', label: 'Ana' } }] });
    expect(html).toBe('<!-- wp:mention {"id":"u1","label":"Ana"} /-->');
  });
});

describe('cross-format round trips', () => {
  it('Tiptap -> Canonical -> Tiptap is lossless through the canonical intermediary', () => {
    const doc = tiptapArticleDoc();
    expect(canonicalToTiptap(tiptapToCanonical(doc))).toEqual(doc);
  });

  it('Tiptap -> Canonical -> WordPress -> Canonical -> Tiptap is stable apart from the media reference', () => {
    const doc = tiptapArticleDoc();
    const back = wordpressToTipTap(tiptapToWordPress(doc));
    expect(withoutMediaIds(back)).toEqual(withoutMediaIds(doc));
  });

  it('WordPress -> Canonical -> Tiptap -> Canonical -> WordPress -> Tiptap is stable apart from the media reference', () => {
    const tipTapOnce = wordpressToTipTap(wordpressRepresentableHtml);
    const tipTapTwice = wordpressToTipTap(tiptapToWordPress(tipTapOnce));
    expect(withoutMediaIds(tipTapTwice)).toEqual(withoutMediaIds(tipTapOnce));
  });

  it('is deterministic in both directions', () => {
    expect(wordpressToTipTap(wordpressArticleHtml)).toEqual(wordpressToTipTap(wordpressArticleHtml));
    expect(tiptapToWordPress(tiptapArticleDoc())).toBe(tiptapToWordPress(tiptapArticleDoc()));
  });
});

/**
 * `mediaId` is an opaque canonical reference. Resolving it to a destination
 * CMS identity (e.g. a WordPress attachment id) requires that CMS's media
 * registry and therefore belongs to the future publishing/import provider, not
 * to this pure, CMS-neutral adapter. The tests below pin that boundary.
 */
describe('media reference provider boundary', () => {
  it('never emits an editor-origin mediaId as a WordPress attachment id', () => {
    const html = tiptapToWordPress({
      type: 'doc',
      content: [{ type: 'image', attrs: { mediaId: 'm1', src: 'https://cdn/x.png', alt: 'x' } }],
    });
    expect(html).not.toContain('"id"');
    expect(html).not.toContain('mediaId');
    expect(html).toContain('src="https://cdn/x.png"');
  });

  it('keeps a WordPress-origin attachment id lossless through the source envelope', () => {
    const html =
      '<!-- wp:image {"id":12345} -->\n<figure class="wp-block-image"><img src="https://cdn/x.png" alt="x"/></figure>\n<!-- /wp:image -->';
    expect(wordpressToCanonical(html).blocks[0]?.attrs?.mediaId).toBe('12345');
    expect(canonicalToWordPress(wordpressToCanonical(html))).toBe(html);
  });

  it('does not fabricate a destination media identity when converting to WordPress', () => {
    const canonical = tiptapToCanonical({
      type: 'doc',
      content: [{ type: 'image', attrs: { mediaId: 'm1', src: 'https://cdn/x.png' } }],
    });
    const html = canonicalToWordPress(canonical);
    expect(html).not.toContain('12345');
    expect(html).not.toContain('"id"');
    expect(html).not.toContain('mediaId');
  });

  it('loses mediaId across TipTap -> WordPress -> TipTap without provider resolution', () => {
    const doc: TipDoc = {
      type: 'doc',
      content: [{ type: 'image', attrs: { mediaId: 'm1', src: 'https://cdn/x.png', alt: 'x' } }, { type: 'paragraph' }],
    };
    const back = wordpressToTipTap(tiptapToWordPress(doc));
    const image = findAllNodes(back, 'image')[0];
    expect(image?.attrs?.mediaId).toBeUndefined();
    expect(image?.attrs).toEqual({ src: 'https://cdn/x.png', alt: 'x' });
    expect(withoutMediaIds(back)).toEqual(withoutMediaIds(doc));
  });
});

describe('lossiness boundary', () => {
  it('keeps a TipTap-only custom node reversible through one WordPress hop', () => {
    const doc: TipDoc = { type: 'doc', content: [{ type: 'mention', attrs: { id: 'u1' }, content: [{ type: 'text', text: '@ana' }] }] };
    const html = tiptapToWordPress(doc);
    expect(html).toContain('<p>@ana</p>');
  });

  it('documents that an unknown void block is not representable in Tiptap', () => {
    const doc = wordpressToTipTap('<!-- wp:acme/badge {"text":"New"} /-->');
    expect(JSON.stringify(doc)).toContain('[unsupported:acme/badge]');
    expect(isValidDocStructure(doc)).toBe(true);
  });

  it('keeps malformed WordPress attribute payloads visible through the bridge', () => {
    const html = '<!-- wp:paragraph {bad json} -->\n<p>Text</p>\n<!-- /wp:paragraph -->';
    const canonical = wordpressToCanonical(html);
    expect(canonical.blocks[0]?.source?.attrsRaw).toBe('{bad json}');
    expect(canonicalToWordPress(canonical)).toBe(html);
    expect(JSON.stringify(wordpressToTipTap(html))).toContain('Text');
  });
});
