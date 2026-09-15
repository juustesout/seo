/**
 * TipTap <-> Canonical Block Document adapter (Stage 1).
 *
 * Pure, dependency-free conversions between the editor's ProseMirror-shaped
 * `TipDoc` and the CMS-neutral `CanonicalDocument`. Stage 1 is additive: the
 * results are never persisted and the editor keeps using `content_json`.
 *
 * Fidelity rules:
 *   - Known nodes project onto semantic canonical types/attrs.
 *   - Unknown nodes become `custom` blocks that keep their original
 *     `source.type`/`source.attrs` and their converted content, so a TipTap ->
 *     canonical -> TipTap round trip restores them exactly. Nothing is dropped.
 *   - Canonical blocks TipTap v2 cannot represent are flattened by an explicit
 *     fallback (see `blockToTiptap`) rather than silently lost.
 *
 * IDs generated here are deterministic (derived from each block's path) but
 * ephemeral: they exist only in the in-memory canonical view, are not persisted,
 * and change when the document structure changes.
 */

import type { TipDoc, TipMark, TipNode } from './contentDoc.js';
import { asTipDoc, isTiptapDoc } from './contentDoc.js';
import type {
  CanonicalBlock,
  CanonicalDocument,
  CanonicalInline,
  CanonicalMark,
  CanonicalText,
  SourceRef,
} from './canonical.js';
import { CANONICAL_DOCUMENT_VERSION } from './canonical.js';

const IMAGE_ATTR_KEYS = ['mediaId', 'src', 'alt', 'caption', 'width', 'height'] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isInlineNode(node: TipNode): boolean {
  return node.type === 'text' || node.type === 'hardBreak';
}

/** Deterministic path id: root `b0`, its children `b0-0`, `b0-0-1`, ... */
function childId(parentId: string | undefined, index: number): string {
  return parentId === undefined ? `b${index}` : `${parentId}-${index}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Copies only the keys actually present, preserving `null` vs missing so
 *  round trips do not invent attributes the source node never had. */
function pickAttrs(
  attrs: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) {
      out[key] = attrs[key];
      any = true;
    }
  }
  return any ? out : undefined;
}

function toCanonicalMarks(marks: TipMark[] | undefined): CanonicalMark[] | undefined {
  if (!marks || marks.length === 0) return undefined;
  return marks.map((mark) => (mark.attrs !== undefined ? { type: mark.type, attrs: mark.attrs } : { type: mark.type }));
}

function fromCanonicalMarks(marks: CanonicalMark[] | undefined): TipMark[] | undefined {
  if (!marks || marks.length === 0) return undefined;
  return marks.map((mark) => (mark.attrs !== undefined ? { type: mark.type, attrs: mark.attrs } : { type: mark.type }));
}

function tiptapSource(node: TipNode): SourceRef {
  return { cms: 'tiptap', type: node.type };
}

function block(partial: CanonicalBlock): CanonicalBlock {
  const out: CanonicalBlock = { id: partial.id, type: partial.type };
  if (partial.attrs && Object.keys(partial.attrs).length > 0) out.attrs = partial.attrs;
  if (partial.content && partial.content.length > 0) out.content = partial.content;
  if (partial.children && partial.children.length > 0) out.children = partial.children;
  if (partial.source) out.source = partial.source;
  if (partial.rawHtml !== undefined) out.rawHtml = partial.rawHtml;
  return out;
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// TipTap -> Canonical
// ---------------------------------------------------------------------------

function toInline(node: TipNode): CanonicalInline {
  if (node.type === 'text') {
    const marks = toCanonicalMarks(node.marks);
    return marks ? { type: 'text', text: node.text ?? '', marks } : { type: 'text', text: node.text ?? '' };
  }
  if (node.type === 'hardBreak') return { type: 'break' };
  const source: SourceRef = { cms: 'tiptap', type: node.type };
  if (node.attrs !== undefined) source.attrs = node.attrs;
  const raw = safeJson(node);
  return raw !== undefined
    ? { type: 'inlineUnsupported', source, raw }
    : { type: 'inlineUnsupported', source };
}

function toInlineContent(nodes: TipNode[] | undefined): CanonicalInline[] {
  return (nodes ?? []).map(toInline);
}

/** Container content: inline when every child is inline (unlikely for real
 *  block containers), otherwise nested blocks. */
function convertChildNodes(
  nodes: TipNode[],
  parentId: string,
): Pick<CanonicalBlock, 'content' | 'children'> {
  if (nodes.length === 0) return {};
  if (nodes.every(isInlineNode)) return { content: nodes.map(toInline) };
  return { children: nodes.flatMap((node, index) => convertNode(node, childId(parentId, index))) };
}

function convertListNode(node: TipNode, id: string, ordered: boolean): CanonicalBlock[] {
  const attrs: Record<string, unknown> = { ordered };
  if (ordered && node.attrs?.start !== undefined) attrs.start = node.attrs.start;
  const children = (node.content ?? []).flatMap((child, index) =>
    convertNode(child, childId(id, index)),
  );
  return [block({ id, type: 'list', attrs, children, source: tiptapSource(node) })];
}

function convertUnknownNode(node: TipNode, id: string): CanonicalBlock {
  const source: SourceRef = { cms: 'tiptap', type: node.type };
  if (node.attrs !== undefined) source.attrs = node.attrs;
  const children = node.content ?? [];
  if (children.length > 0) {
    if (children.every(isInlineNode)) {
      return { id, type: 'custom', source, content: children.map(toInline) };
    }
    return {
      id,
      type: 'custom',
      source,
      children: children.flatMap((child, index) => convertNode(child, childId(id, index))),
    };
  }
  if (typeof node.text === 'string') {
    const marks = toCanonicalMarks(node.marks);
    const text: CanonicalText = marks
      ? { type: 'text', text: node.text, marks }
      : { type: 'text', text: node.text };
    return { id, type: 'custom', source, content: [text] };
  }
  return { id, type: 'custom', source };
}

function convertNode(node: TipNode, id: string): CanonicalBlock[] {
  switch (node.type) {
    case 'paragraph':
      return [
        block({ id, type: 'paragraph', content: toInlineContent(node.content), source: tiptapSource(node) }),
      ];
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 2;
      return [
        block({
          id,
          type: 'heading',
          attrs: { level },
          content: toInlineContent(node.content),
          source: tiptapSource(node),
        }),
      ];
    }
    case 'bulletList':
      return convertListNode(node, id, false);
    case 'orderedList':
      return convertListNode(node, id, true);
    case 'listItem':
      return [
        block({ id, type: 'listItem', ...convertChildNodes(node.content ?? [], id), source: tiptapSource(node) }),
      ];
    case 'blockquote':
      return [
        block({ id, type: 'quote', ...convertChildNodes(node.content ?? [], id), source: tiptapSource(node) }),
      ];
    case 'codeBlock':
      return [
        block({
          id,
          type: 'code',
          attrs: pickAttrs(node.attrs, ['language']),
          content: toInlineContent(node.content),
          source: tiptapSource(node),
        }),
      ];
    case 'horizontalRule':
      return [block({ id, type: 'divider', source: tiptapSource(node) })];
    case 'image':
      return [
        block({ id, type: 'image', attrs: pickAttrs(node.attrs, IMAGE_ATTR_KEYS), source: tiptapSource(node) }),
      ];
    default:
      return [convertUnknownNode(node, id)];
  }
}

/**
 * Converts any Tiptap document (docs pass through; legacy/junk is normalized via
 * `asTipDoc`) into a canonical document. Never throws and never drops content.
 */
export function tiptapToCanonical(doc: TipDoc | unknown): CanonicalDocument {
  const root = isTiptapDoc(doc) ? doc : asTipDoc(doc);
  return {
    version: CANONICAL_DOCUMENT_VERSION,
    blocks: (root.content ?? []).flatMap((node, index) => convertNode(node, childId(undefined, index))),
  };
}

// ---------------------------------------------------------------------------
// Canonical -> TipTap
// ---------------------------------------------------------------------------

function paragraphOfText(text: string): TipNode {
  return text.length > 0 ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' };
}

function inlineToTiptap(inline: CanonicalInline): TipNode {
  if (inline.type === 'text') {
    const marks = fromCanonicalMarks(inline.marks);
    return marks ? { type: 'text', text: inline.text, marks } : { type: 'text', text: inline.text };
  }
  if (inline.type === 'break') return { type: 'hardBreak' };
  const restored = nodeFromRaw(inline.raw);
  if (restored) return restored;
  const label = inline.source?.type ? `[unsupported:${inline.source.type}]` : '[unsupported]';
  return { type: 'text', text: label };
}

function nodeFromRaw(raw: string | undefined): TipNode | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as TipNode).type === 'string') {
      return parsed as TipNode;
    }
  } catch {
    return null;
  }
  return null;
}

function withInline(node: TipNode, content: CanonicalInline[] | undefined): TipNode {
  if (content && content.length > 0) node.content = content.map(inlineToTiptap);
  return node;
}

function listItemToTiptap(blockValue: CanonicalBlock): TipNode {
  const node: TipNode = { type: 'listItem' };
  const children = (blockValue.children ?? []).flatMap(blockToTiptap);
  if (children.length > 0) node.content = children;
  else if (blockValue.content && blockValue.content.length > 0) {
    node.content = [withInline({ type: 'paragraph' }, blockValue.content)];
  }
  return node;
}

function imageToTiptap(blockValue: CanonicalBlock): TipNode {
  const node: TipNode = { type: 'image' };
  const attrs = pickAttrs(blockValue.attrs, IMAGE_ATTR_KEYS);
  if (attrs) node.attrs = attrs;
  return node;
}

/** Rebuilds a node that came from TipTap and was carried as `custom`, using the
 *  preserved source type/attrs plus converted content. */
function reconstructTiptapNode(blockValue: CanonicalBlock): TipNode {
  const source = blockValue.source as SourceRef;
  const node: TipNode = { type: source.type as string };
  if (source.attrs !== undefined) node.attrs = source.attrs;
  if (blockValue.children && blockValue.children.length > 0) {
    node.content = blockValue.children.flatMap(blockToTiptap);
  } else if (blockValue.content && blockValue.content.length > 0) {
    const [first] = blockValue.content;
    if (source.type === 'text' && blockValue.content.length === 1 && first?.type === 'text') {
      node.text = (first as CanonicalText).text;
      const marks = fromCanonicalMarks((first as CanonicalText).marks);
      if (marks) node.marks = marks;
    } else {
      node.content = blockValue.content.map(inlineToTiptap);
    }
  }
  return node;
}

/**
 * Explicit fallback for canonical blocks TipTap v2 cannot represent yet
 * (tables, groups/columns, embeds, `html`, WordPress-only `custom`). Policy:
 * keep children in order; wrap inline content in a paragraph; expose `rawHtml`
 * as paragraph text. Nothing is dropped, and the transform is declared lossy.
 */
function fallbackToTiptap(blockValue: CanonicalBlock): TipNode[] {
  const children = (blockValue.children ?? []).flatMap(blockToTiptap);
  if (children.length > 0) return children;
  if (blockValue.content && blockValue.content.length > 0) {
    return [withInline({ type: 'paragraph' }, blockValue.content)];
  }
  if (typeof blockValue.rawHtml === 'string') return [paragraphOfText(blockValue.rawHtml)];
  return [{ type: 'paragraph' }];
}

function blockToTiptap(blockValue: CanonicalBlock): TipNode[] {
  switch (blockValue.type) {
    case 'paragraph':
      return [withInline({ type: 'paragraph' }, blockValue.content)];
    case 'heading': {
      const level = typeof blockValue.attrs?.level === 'number' ? clamp(blockValue.attrs.level, 1, 6) : 2;
      return [withInline({ type: 'heading', attrs: { level } }, blockValue.content)];
    }
    case 'list': {
      const ordered = blockValue.attrs?.ordered === true;
      const node: TipNode = { type: ordered ? 'orderedList' : 'bulletList' };
      if (ordered && typeof blockValue.attrs?.start === 'number') {
        node.attrs = { start: blockValue.attrs.start };
      }
      const items = (blockValue.children ?? []).flatMap(blockToTiptap);
      if (items.length > 0) node.content = items;
      return [node];
    }
    case 'listItem':
      return [listItemToTiptap(blockValue)];
    case 'quote': {
      const node: TipNode = { type: 'blockquote' };
      const inner = (blockValue.children ?? []).flatMap(blockToTiptap);
      if (inner.length > 0) node.content = inner;
      return [node];
    }
    case 'code': {
      const node: TipNode = { type: 'codeBlock' };
      if (blockValue.attrs && 'language' in blockValue.attrs) node.attrs = { language: blockValue.attrs.language };
      return [withInline(node, blockValue.content)];
    }
    case 'divider':
      return [{ type: 'horizontalRule' }];
    case 'image':
      return [imageToTiptap(blockValue)];
    case 'custom':
      if (blockValue.source?.cms === 'tiptap' && blockValue.source.type) return [reconstructTiptapNode(blockValue)];
      return fallbackToTiptap(blockValue);
    default:
      return fallbackToTiptap(blockValue);
  }
}

/**
 * Converts a canonical document into an editor-ready Tiptap document. Supported
 * blocks map exactly; unsupported blocks follow `fallbackToTiptap`.
 */
export function canonicalToTiptap(doc: CanonicalDocument): TipDoc {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const content = blocks.flatMap(blockToTiptap);
  return content.length > 0 ? { type: 'doc', content } : { type: 'doc' };
}
