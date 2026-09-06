/**
 * Tiptap / ProseMirror document model.
 *
 * content_json on seo_content is the canonical content representation. As of
 * Phase B it is a Tiptap JSON document ({type:'doc', content:[...]}). Older
 * records may still hold the legacy block-array model; every consumer should
 * go through the detect-and-normalize helpers here so both representations
 * keep working without a destructive migration.
 *
 * HTML is always derived output, never authored directly.
 */

import type { ContentBlock, ContentHeadingLevel, ContentOutlineItem } from './content.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TipMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TipNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: TipMark[];
  content?: TipNode[];
}

export interface TipDoc {
  type: 'doc';
  content?: TipNode[];
}

/** Node types the Phase B editor emits (StarterKit + link). */
export const TIPTAP_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'hardBreak',
  'horizontalRule',
]);

export const TIPTAP_MARK_TYPES = new Set(['bold', 'italic', 'strike', 'code', 'link']);

// ---------------------------------------------------------------------------
// Detection / validation
// ---------------------------------------------------------------------------

/** True when the value looks like a Tiptap document root node. */
export function isTiptapDoc(value: unknown): value is TipDoc {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as TipDoc).type === 'doc'
  );
}

/** Basic structural check used at write time to reject obviously invalid JSON. */
export function isValidDocStructure(value: unknown): boolean {
  if (!isTiptapDoc(value)) return false;
  const content = value.content ?? [];
  if (!Array.isArray(content) || content.length > 2000) return false;
  const walk = (nodes: TipNode[], parentBlock: string | null): boolean => {
    for (const node of nodes) {
      if (!node || typeof node !== 'object' || typeof node.type !== 'string') return false;
      if (node.type === 'text') {
        if (typeof node.text !== 'string') return false;
        if (node.marks && !node.marks.every((m) => m && TIPTAP_MARK_TYPES.has(m.type))) return false;
        continue;
      }
      if (node.type === 'heading') {
        const level = (node.attrs as { level?: unknown } | undefined)?.level;
        if (typeof level !== 'number' || level < 1 || level > 6) return false;
      }
      if (node.type === 'codeBlock') {
        // Code block text is a child text node; no nested block elements.
        if (node.content && !node.content.every((c) => c.type === 'text')) return false;
      }
      if (!TIPTAP_BLOCK_TYPES.has(node.type)) return false;
      if (node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'listItem') {
        if (!Array.isArray(node.content)) return false;
        const inner = node.content as TipNode[];
        if (!inner.every((c) => c && (c.type === 'listItem' || c.type === 'paragraph' || c.type === 'text'))) {
          return false;
        }
        if (!walk(inner, node.type)) return false;
      } else if (node.content && !walk(node.content as TipNode[], node.type)) {
        return false;
      }
    }
    return true;
  };
  return walk(content, 'doc');
}

/** A brand-new empty document (single empty paragraph). */
export function tiptapEmptyDoc(): TipDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

// ---------------------------------------------------------------------------
// Authoring text helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(node: TipNode): string {
  if (node.type === 'text') {
    let text = escapeHtml(node.text ?? '');
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') text = `<strong>${text}</strong>`;
      else if (mark.type === 'italic') text = `<em>${text}</em>`;
      else if (mark.type === 'strike') text = `<s>${text}</s>`;
      else if (mark.type === 'code') text = `<code>${text}</code>`;
      else if (mark.type === 'link') {
        const href = (mark.attrs as { href?: unknown } | undefined)?.href;
        const target = (mark.attrs as { target?: unknown } | undefined)?.target;
        const safe = typeof href === 'string' ? href : '';
        const rel = typeof target === 'string' && target === '_blank' ? ' rel="noopener"' : '';
        text = `<a href="${escapeHtml(safe)}"${rel}>${text}</a>`;
      }
    }
    return text;
  }
  return (node.content ?? []).map(renderInline).join('');
}

/** Plain inline text of a node (marks stripped) — used for outline/analysis. */
export function inlineText(node: TipNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(inlineText).join('');
}

// ---------------------------------------------------------------------------
// Derived output: HTML
// ---------------------------------------------------------------------------

/** Render a Tiptap document to semantic HTML (single authoritative renderer). */
export function renderDocHtml(doc: TipDoc): string {
  const walk = (nodes: TipNode[]): string => {
    const out: string[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case 'paragraph': {
          const html = renderInlineChildren(node);
          if (html) out.push(`<p>${html}</p>`);
          break;
        }
        case 'heading': {
          const level = (node.attrs as { level?: unknown } | undefined)?.level;
          const l = typeof level === 'number' ? Math.min(6, Math.max(1, level)) : 2;
          out.push(`<h${l}>${renderInlineChildren(node)}</h${l}>`);
          break;
        }
        case 'bulletList':
          out.push(`<ul>${walk(node.content ?? [])}</ul>`);
          break;
        case 'orderedList':
          out.push(`<ol>${walk(node.content ?? [])}</ol>`);
          break;
        case 'listItem':
          out.push(`<li>${walk(node.content ?? [])}</li>`);
          break;
        case 'blockquote': {
          const html = walk(node.content ?? []);
          if (html) out.push(`<blockquote>${html}</blockquote>`);
          break;
        }
        case 'codeBlock':
          out.push(`<pre><code>${escapeHtml(node.content?.map((c) => c.text ?? '').join('') ?? '')}</code></pre>`);
          break;
        case 'hardBreak':
          out.push('<br>');
          break;
        case 'horizontalRule':
          out.push('<hr>');
          break;
        default:
          out.push(walk(node.content ?? []));
      }
    }
    return out.join('\n');
  };
  return walk(doc.content ?? []);
}

function renderInlineChildren(node: TipNode): string {
  return (node.content ?? []).map(renderInline).join('');
}

// ---------------------------------------------------------------------------
// Derived output: text, headings, word count, introduction
// ---------------------------------------------------------------------------

/** Plain text of a whole document, paragraphs separated by blank lines. */
export function docPlainText(doc: TipDoc): string {
  const parts: string[] = [];
  const walkBlock = (nodes: TipNode[], depth: number): void => {
    for (const node of nodes) {
      switch (node.type) {
        case 'paragraph':
        case 'heading': {
          const text = inlineText(node).trim();
          if (text) parts.push(text);
          break;
        }
        case 'bulletList':
        case 'orderedList':
        case 'listItem':
        case 'blockquote':
          walkBlock(node.content ?? [], depth + 1);
          break;
        case 'codeBlock':
          parts.push((node.content ?? []).map((c) => c.text ?? '').join(''));
          break;
        default:
          break;
      }
    }
  };
  walkBlock(doc.content ?? [], 0);
  return parts.join('\n');
}

/** Headings in document order with hierarchy (drives the outline). */
export function docHeadings(doc: TipDoc): ContentOutlineItem[] {
  const items: ContentOutlineItem[] = [];
  const walk = (nodes: TipNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'heading') {
        const level = (node.attrs as { level?: unknown } | undefined)?.level;
        const text = inlineText(node).trim();
        if (typeof level === 'number' && text) {
          items.push({ level: Math.min(6, Math.max(1, level)) as ContentOutlineItem['level'], text });
        }
      } else if (node.content) {
        walk(node.content as TipNode[]);
      }
    }
  };
  walk(doc.content ?? []);
  return items;
}

export function docWordCount(doc: TipDoc): number {
  return docPlainText(doc).split(/\s+/).filter(Boolean).length;
}

/** First non-empty paragraph/heading text — candidate introduction signal. */
export function docIntroduction(doc: TipDoc): string {
  for (const node of doc.content ?? []) {
    if (node.type === 'paragraph' || node.type === 'heading') {
      const text = inlineText(node).trim();
      if (text) return text;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Legacy block-model compatibility
// ---------------------------------------------------------------------------

/**
 * Convert any stored content_json into the legacy block-array model so
 * existing analysis, agent and job code keeps working unchanged.
 */
export function asContentBlocks(value: unknown): ContentBlock[] {
  if (Array.isArray(value)) {
    return value as ContentBlock[];
  }
  if (!isTiptapDoc(value)) return [];
  const out: ContentBlock[] = [];
  for (const node of value.content ?? []) {
    switch (node.type) {
      case 'paragraph':
        out.push({ type: 'paragraph', attrs: { text: inlineText(node) } });
        break;
      case 'heading': {
        const level = (node.attrs as { level?: unknown } | undefined)?.level;
        const n = typeof level === 'number' ? Math.min(6, Math.max(1, level)) : 2;
        out.push({ type: 'heading', attrs: { level: n as ContentHeadingLevel, text: inlineText(node) } });
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        const ordered = node.type === 'orderedList';
        const items = (node.content ?? [])
          .filter((c) => c.type === 'listItem')
          .map((c) => inlineText(c));
        out.push({ type: 'list', attrs: { ordered, items } });
        break;
      }
      case 'blockquote':
        out.push({ type: 'quote', attrs: { text: inlineText(node) } });
        break;
      case 'codeBlock':
        out.push({ type: 'code', attrs: { text: (node.content ?? []).map((c) => c.text ?? '').join('') } });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Unified outline: headings for docs, heading blocks for legacy arrays. */
export function contentOutlineOf(value: unknown): ContentOutlineItem[] {
  if (isTiptapDoc(value)) return docHeadings(value);
  if (Array.isArray(value)) return legacyOutline(value as ContentBlock[]);
  return [];
}

/** Unified plain text extraction for both stored shapes. */
export function contentTextOf(value: unknown): string {
  if (isTiptapDoc(value)) return docPlainText(value);
  if (Array.isArray(value)) {
    return (value as ContentBlock[])
      .map((b) => {
        if (b.type === 'heading' || b.type === 'paragraph' || b.type === 'quote' || b.type === 'code') {
          return b.attrs.text;
        }
        if (b.type === 'list') return b.attrs.items.join(' ');
        if (b.type === 'link') return b.attrs.text;
        return '';
      })
      .join('\n');
  }
  return '';
}

function legacyOutline(blocks: ContentBlock[]): ContentOutlineItem[] {
  const items: ContentOutlineItem[] = [];
  for (const block of blocks) {
    if (block.type === 'heading' && block.attrs.text.trim()) {
      items.push({ level: block.attrs.level, text: block.attrs.text.trim() });
    }
  }
  return items;
}

function textNode(text: string, marks?: TipMark[]): TipNode {
  return { type: 'text', text, ...(marks && marks.length ? { marks } : {}) } as TipNode;
}

function paragraphOf(text: string, marks?: TipMark[]): TipNode {
  const node: TipNode = { type: 'paragraph', content: [] };
  const t = text.trim();
  if (t) node.content = [textNode(t, marks)];
  return node;
}

function listItemOf(text: string): TipNode {
  return { type: 'listItem', content: [paragraphOf(text)] };
}

/**
 * Convert a legacy block array into an editable Tiptap document. Media blocks
 * and empty blocks are dropped (no fabrication); a document always has at
 * least one paragraph. Inverse of {@link asContentBlocks}.
 */
export function docFromBlocks(blocks: ContentBlock[]): TipDoc {
  const content: TipNode[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const text = block.attrs.text.trim();
        if (!text) break;
        content.push({ type: 'heading', attrs: { level: block.attrs.level as ContentHeadingLevel }, content: [textNode(text)] });
        break;
      }
      case 'paragraph': {
        const node = paragraphOf(block.attrs.text);
        if (node.content && node.content.length) content.push(node);
        break;
      }
      case 'list': {
        const items = block.attrs.items.filter((i) => i.trim());
        if (!items.length) break;
        content.push({
          type: block.attrs.ordered ? 'orderedList' : 'bulletList',
          content: items.map(listItemOf),
        });
        break;
      }
      case 'quote': {
        const text = block.attrs.text.trim();
        if (!text) break;
        content.push({ type: 'blockquote', content: [paragraphOf(text)] });
        break;
      }
      case 'code': {
        const text = block.attrs.text;
        if (!text.trim()) break;
        content.push({ type: 'codeBlock', content: [textNode(text)] });
        break;
      }
      case 'link': {
        const node = paragraphOf(block.attrs.text, [{ type: 'link', attrs: { href: block.attrs.href } }]);
        if (node.content && node.content.length) content.push(node);
        break;
      }
      default:
        break;
    }
  }
  return { type: 'doc', content: content.length ? content : [paragraphOf('')] };
}

/**
 * Canonical editor input: returns a valid Tiptap document for any stored
 * content_json (docs pass through, legacy arrays are converted, anything else
 * yields an empty document). Invalid JSON objects never reach the editor.
 */
export function asTipDoc(value: unknown): TipDoc {
  if (isTiptapDoc(value)) return value;
  if (Array.isArray(value)) return docFromBlocks(value as ContentBlock[]);
  return tiptapEmptyDoc();
}
