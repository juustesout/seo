import { Node } from '@tiptap/core';
import type { DOMOutputSpec, Node as PmNode, ResolvedPos } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

/**
 * Phase F image node. A block-level leaf that carries a stable reference to a
 * project media-library row (`mediaId`) plus the public object `src` the server
 * resolved on the last save. Documents keep `mediaId` as the canonical value;
 * the editor previews through `src` and the server re-resolves it on every
 * save, so a stale or forged URL can never leak in.
 *
 * The node only round-trips images that carry a `data-media-id` - a plain
 * pasted <img> has no library reference and is dropped rather than imported.
 */

interface ImageAttrs {
  mediaId: string | null;
  src: string | null;
  alt: string;
  caption: string;
  width: number | null;
  height: number | null;
}

function dims(attrs: ImageAttrs): Record<string, string> {
  const out: Record<string, string> = {};
  if (attrs.width != null && Number.isFinite(attrs.width)) out.width = String(attrs.width);
  if (attrs.height != null && Number.isFinite(attrs.height)) out.height = String(attrs.height);
  return out;
}

function imgOf(el: Element): HTMLImageElement | null {
  if (el instanceof HTMLImageElement) return el;
  return el.querySelector('img');
}

function numAttr(el: Element, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null) return null;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function attrsFromFigure(el: Element): Record<string, unknown> | false {
  const img = imgOf(el);
  const mediaId = img?.getAttribute('data-media-id') ?? el.getAttribute('data-media-id');
  if (!mediaId) return false;
  const src = img?.getAttribute('src') ?? null;
  const caption = el.querySelector('figcaption')?.textContent?.trim() ?? '';
  return {
    mediaId,
    src,
    alt: img?.getAttribute('alt') ?? '',
    caption,
    width: img ? numAttr(img, 'width') : null,
    height: img ? numAttr(img, 'height') : null,
  };
}

function attrsFromImg(el: Element): Record<string, unknown> | false {
  const mediaId = el.getAttribute('data-media-id');
  if (!mediaId) return false;
  return {
    mediaId,
    src: el.getAttribute('src') ?? null,
    alt: el.getAttribute('alt') ?? '',
    caption: '',
    width: numAttr(el, 'width'),
    height: numAttr(el, 'height'),
  };
}

export interface InsertMediaAttrs {
  mediaId: string;
  src: string;
  alt?: string;
  caption?: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    imageBlock: {
      /**
       * Insert a library image at the caret. When the caret sits in an empty
       * paragraph the paragraph is replaced; otherwise the image is placed
       * right after the block that contains the caret, so the insertion always
       * lands on a valid block boundary.
       */
      insertMedia: (attrs: InsertMediaAttrs) => ReturnType;
    };
  }
}

export const ImageBlock = Node.create({
  name: 'image',

  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      mediaId: {
        default: null,
        parseHTML: (el) => imgOf(el)?.getAttribute('data-media-id') ?? el.getAttribute('data-media-id') ?? null,
        renderHTML: () => ({}),
      },
      src: {
        default: null,
        parseHTML: (el) => imgOf(el)?.getAttribute('src') ?? null,
        renderHTML: () => ({}),
      },
      alt: {
        default: '',
        parseHTML: (el) => imgOf(el)?.getAttribute('alt') ?? '',
        renderHTML: () => ({}),
      },
      caption: {
        default: '',
        parseHTML: (el) => el.querySelector('figcaption')?.textContent?.trim() ?? '',
        renderHTML: () => ({}),
      },
      width: {
        default: null,
        parseHTML: (el) => {
          const img = imgOf(el);
          if (!img) return null;
          const raw = img.getAttribute('width');
          const v = raw === null ? Number.NaN : Number.parseInt(raw, 10);
          return Number.isFinite(v) && v > 0 ? v : null;
        },
        renderHTML: () => ({}),
      },
      height: {
        default: null,
        parseHTML: (el) => {
          const img = imgOf(el);
          if (!img) return null;
          const raw = img.getAttribute('height');
          const v = raw === null ? Number.NaN : Number.parseInt(raw, 10);
          return Number.isFinite(v) && v > 0 ? v : null;
        },
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'figure.seo-media', getAttrs: (el) => attrsFromFigure(el as Element), priority: 60 },
      { tag: 'img[data-media-id]', getAttrs: (el) => attrsFromImg(el as Element) },
    ];
  },

  renderHTML({ node, HTMLAttributes }): DOMOutputSpec {
    const attrs = node.attrs as ImageAttrs;
    const hasSrc = typeof attrs.src === 'string' && attrs.src.length > 0;
    const figureAttrs = mergeAttrs(HTMLAttributes, { class: hasSrc ? 'seo-media' : 'seo-media seo-media-missing' });

    const children: unknown[] = [];
    if (!attrs.mediaId) {
      children.push('image');
    } else if (!hasSrc) {
      children.push(['span', { class: 'seo-media-placeholder' }, 'image — upload again or remove']);
    } else {
      const imgAttrs = mergeAttrs({}, { src: attrs.src, alt: attrs.alt || '', 'data-media-id': attrs.mediaId }, dims(attrs));
      children.push(['img', imgAttrs]);
      if (typeof attrs.caption === 'string' && attrs.caption.length > 0) {
        children.push(['figcaption', {}, attrs.caption]);
      }
    }
    return ['figure', figureAttrs, ...children] as unknown as DOMOutputSpec;
  },

  addCommands() {
    return {
      insertMedia:
        (opts: InsertMediaAttrs) =>
        ({ tr, state, dispatch }) => {
          const type = state.schema.nodes.image;
          if (!type) return false;
          const node = type.create({ ...opts, alt: opts.alt ?? '', caption: opts.caption ?? '' });

          const { from, to, empty } = state.selection;
          if (!empty) {
            // Only inline selections inside a single textblock collapse cleanly
            // to a caret; anything spanning blocks is left alone.
            const $start = state.doc.resolve(from);
            const $end = state.doc.resolve(to);
            if (!$start.sameParent($end)) return false;
            tr.deleteRange(from, to);
            const $pos = tr.doc.resolve(tr.mapping.map(from));
            insertAtBlockBoundary(tr, $pos, node);
            if (dispatch) dispatch(tr);
            return true;
          }

          const $pos = state.doc.resolve(from);
          if (!insertAtBlockBoundary(tr, $pos, node)) return false;
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});

function mergeAttrs(...parts: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> {
  return Object.assign({}, ...parts);
}

/** Put the image on a valid block boundary: replace an empty paragraph, or
 *  insert after the block that owns the caret. Returns false when no safe spot
 *  exists (e.g. the caret sits inside a code block). */
function insertAtBlockBoundary(tr: Transaction, $pos: ResolvedPos, node: PmNode): boolean {
  const parent = $pos.parent;
  if (parent.type.spec.code) return false;

  if (parent.isTextblock && parent.childCount === 0) {
    const start = $pos.start($pos.depth);
    const end = start + parent.nodeSize;
    tr.replaceWith(start, end, node);
    return true;
  }

  if (parent.isTextblock) {
    const after = $pos.after($pos.depth);
    tr.insert(after, node);
    return true;
  }

  // Block-level caret (gap cursor or after a selected node).
  tr.insert($pos.pos, node);
  return true;
}
