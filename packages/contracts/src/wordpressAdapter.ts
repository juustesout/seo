/**
 * WordPress block <-> Canonical Block Document adapter (Stage 2).
 *
 * Pure, dependency-free conversions between WordPress `post_content` block
 * markup and the CMS-neutral `CanonicalDocument`. The WordPress grammar is
 * implemented here directly (tokenizer + `innerContent` model, as documented by
 * the WordPress block serialization spec); no WordPress package is imported and
 * the implementation is owned by this package.
 *
 * Fidelity rules:
 *   - Every parsed block keeps a `source` envelope (`cms: 'wordpress'`, original
 *     block name, raw attributes, and WordPress `innerContent`) so a
 *     WordPress -> canonical -> WordPress round trip is byte-exact, including
 *     whitespace, freeform HTML and CMS-specific attributes.
 *   - Known `core/...` blocks additionally project onto semantic canonical
 *     types/attrs for AI and analytics.
 *   - Unknown blocks survive as `custom` with their original identity in
 *     `source`; nothing is dropped.
 *   - Freeform HTML outside block delimiters survives as `html`/`rawHtml`.
 *
 * The serializer prefers the preserved `source.innerContent` (byte-exact) and
 * falls back to rendering semantic canonical blocks for documents built outside
 * this adapter.
 *
 * No DOM, no React, no network, no WordPress dependency.
 */

import type { CanonicalBlock, CanonicalDocument, CanonicalInline, CanonicalMark, SourceRef } from './canonical.js';
import { CANONICAL_DOCUMENT_VERSION, CANONICAL_MAX_BLOCKS } from './canonical.js';

// ---------------------------------------------------------------------------
// Safety bounds
// ---------------------------------------------------------------------------

/** Maximum accepted document size, in UTF-16 code units. */
export const WORDPRESS_MAX_INPUT_CHARS = 5_000_000;
/** Maximum nesting depth of block comments. */
export const WORDPRESS_MAX_DEPTH = 200;
/** Maximum number of blocks (including freeform), aligned with canonical. */
export const WORDPRESS_MAX_BLOCKS = CANONICAL_MAX_BLOCKS;
/** Maximum size of a single block's JSON attribute object. */
export const WORDPRESS_MAX_ATTRIBUTES_CHARS = 100_000;
/** Maximum size of preserved raw/inner HTML for a single block. */
export const WORDPRESS_MAX_RAW_HTML_CHARS = 2_000_000;

export type WordPressAdapterErrorCode =
  | 'input_too_large'
  | 'too_many_blocks'
  | 'max_depth_exceeded'
  | 'attributes_too_large'
  | 'raw_html_too_large';

/**
 * Structured failure for hard safety-budget violations. Malformed markup and
 * malformed attribute JSON are tolerated and never throw; only budget overflows
 * do, so content is never silently truncated.
 */
export class WordPressAdapterError extends Error {
  readonly code: WordPressAdapterErrorCode;

  constructor(code: WordPressAdapterErrorCode, message: string) {
    super(message);
    this.name = 'WordPressAdapterError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// WordPress block model (interchange shape before canonical projection)
// ---------------------------------------------------------------------------

interface WpBlock {
  /** Full block name (`core/paragraph`, `acme/widget`); null for freeform. */
  blockName: string | null;
  attrs: Record<string, unknown> | null;
  /** Original attribute payload text, kept for lossless round trips. */
  attrsRaw: string | null;
  innerBlocks: WpBlock[];
  innerHTML: string;
  /** Static HTML fragments interleaved with `null` at each child position. */
  innerContent: Array<string | null>;
}

interface WpFrame {
  block: WpBlock;
  tokenStart: number;
  prevOffset: number;
  leadingHtmlStart: number | null;
}

interface WpToken {
  kind: 'opener' | 'closer' | 'void';
  blockName: string;
  attrs: Record<string, unknown> | null;
  attrsRaw: string | null;
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

function isNameStart(ch: string): boolean {
  return ch >= 'a' && ch <= 'z';
}

function isNameChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '-';
}

function readName(html: string, start: number): { value: string; next: number } | null {
  if (!isNameStart(html.charAt(start))) return null;
  let i = start + 1;
  while (i < html.length && isNameChar(html.charAt(i))) i += 1;
  return { value: html.slice(start, i), next: i };
}

/** Scan a balanced `{...}` JSON object, respecting string literals. Returns the
 *  index of the closing brace, or -1 when unbalanced. */
function findObjectEnd(html: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseAttrs(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Reads a block comment token starting exactly at `start` (`<!--`). */
function readTokenAt(html: string, start: number): WpToken | null {
  if (!html.startsWith('<!--', start)) return null;
  let i = start + 4;
  if (!isSpace(html.charAt(i))) return null;
  while (isSpace(html.charAt(i))) i += 1;

  let closer = false;
  if (html.charAt(i) === '/') {
    closer = true;
    i += 1;
  }
  if (!html.startsWith('wp:', i)) return null;
  i += 3;

  const first = readName(html, i);
  if (!first) return null;
  i = first.next;
  let blockName: string;
  if (html.charAt(i) === '/') {
    const second = readName(html, i + 1);
    if (!second) return null;
    blockName = `${first.value}/${second.value}`;
    i = second.next;
  } else {
    blockName = `core/${first.value}`;
  }

  if (!isSpace(html.charAt(i))) return null;
  while (isSpace(html.charAt(i))) i += 1;

  let attrs: Record<string, unknown> | null = null;
  let attrsRaw: string | null = null;
  if (html.charAt(i) === '{') {
    const end = findObjectEnd(html, i);
    if (end < 0) return null;
    const raw = html.slice(i, end + 1);
    if (raw.length > WORDPRESS_MAX_ATTRIBUTES_CHARS) {
      throw new WordPressAdapterError('attributes_too_large', `block attributes exceed ${WORDPRESS_MAX_ATTRIBUTES_CHARS} characters`);
    }
    attrs = parseAttrs(raw);
    attrsRaw = raw;
    i = end + 1;
    if (!isSpace(html.charAt(i))) return null;
    while (isSpace(html.charAt(i))) i += 1;
  }

  let isVoid = false;
  if (html.charAt(i) === '/') {
    isVoid = true;
    i += 1;
  }
  if (!html.startsWith('-->', i)) return null;
  i += 3;

  if (isVoid) return { kind: 'void', blockName, attrs, attrsRaw, start, end: i };
  if (closer) return { kind: 'closer', blockName, attrs: null, attrsRaw: null, start, end: i };
  return { kind: 'opener', blockName, attrs, attrsRaw, start, end: i };
}

function findNextToken(html: string, from: number): WpToken | null {
  let search = from;
  while (search < html.length) {
    const idx = html.indexOf('<!--', search);
    if (idx < 0) return null;
    const token = readTokenAt(html, idx);
    if (token) return token;
    search = idx + 4;
  }
  return null;
}

// ---------------------------------------------------------------------------
// WordPress parse -> block tree
// ---------------------------------------------------------------------------

function makeBlock(token: WpToken): WpBlock {
  return { blockName: token.blockName, attrs: token.attrs, attrsRaw: token.attrsRaw, innerBlocks: [], innerHTML: '', innerContent: [] };
}

function freeformBlock(text: string): WpBlock {
  return { blockName: null, attrs: null, attrsRaw: null, innerBlocks: [], innerHTML: text, innerContent: [text] };
}

function parseWpBlocks(html: string): WpBlock[] {
  if (html.length > WORDPRESS_MAX_INPUT_CHARS) {
    throw new WordPressAdapterError('input_too_large', `input exceeds ${WORDPRESS_MAX_INPUT_CHARS} characters`);
  }

  const output: WpBlock[] = [];
  const stack: WpFrame[] = [];
  let offset = 0;
  let blocks = 0;

  const budget = (count: number): void => {
    blocks += count;
    if (blocks > WORDPRESS_MAX_BLOCKS) {
      throw new WordPressAdapterError('too_many_blocks', `document exceeds ${WORDPRESS_MAX_BLOCKS} blocks`);
    }
  };

  const checkRawHtml = (value: string): void => {
    if (value.length > WORDPRESS_MAX_RAW_HTML_CHARS) {
      throw new WordPressAdapterError('raw_html_too_large', `block HTML exceeds ${WORDPRESS_MAX_RAW_HTML_CHARS} characters`);
    }
  };

  const pushFreeform = (text: string): void => {
    if (text.length === 0) return;
    checkRawHtml(text);
    budget(1);
    output.push(freeformBlock(text));
  };

  const addFreeform = (rawLength?: number): void => {
    const length = rawLength ?? html.length - offset;
    if (length <= 0) return;
    pushFreeform(html.slice(offset, offset + length));
  };

  const addInnerBlock = (block: WpBlock, tokenStart: number, lastOffset: number): void => {
    const parent = stack[stack.length - 1];
    if (!parent) return;
    parent.block.innerBlocks.push(block);
    const gap = html.slice(parent.prevOffset, tokenStart);
    if (gap) {
      checkRawHtml(parent.block.innerHTML + gap);
      parent.block.innerHTML += gap;
      parent.block.innerContent.push(gap);
    }
    parent.block.innerContent.push(null);
    parent.prevOffset = lastOffset;
  };

  const addBlockFromStack = (endOffset?: number): void => {
    const frame = stack.pop();
    if (!frame) return;
    const part = endOffset !== undefined ? html.slice(frame.prevOffset, endOffset) : html.slice(frame.prevOffset);
    if (part) {
      checkRawHtml(frame.block.innerHTML + part);
      frame.block.innerHTML += part;
      frame.block.innerContent.push(part);
    }
    if (frame.leadingHtmlStart !== null) {
      pushFreeform(html.slice(frame.leadingHtmlStart, frame.tokenStart));
    }
    budget(1);
    output.push(frame.block);
  };

  for (;;) {
    const token = findNextToken(html, offset);
    const leadingHtmlStart = token && token.start > offset ? offset : null;

    if (!token) {
      if (stack.length === 0) {
        addFreeform();
        break;
      }
      if (stack.length === 1) {
        addBlockFromStack();
        break;
      }
      while (stack.length > 0) addBlockFromStack();
      break;
    }

    if (token.kind === 'void') {
      budget(1);
      const block = makeBlock(token);
      if (stack.length === 0) {
        if (leadingHtmlStart !== null) pushFreeform(html.slice(leadingHtmlStart, token.start));
        output.push(block);
      } else {
        if (stack.length + 1 > WORDPRESS_MAX_DEPTH) {
          throw new WordPressAdapterError('max_depth_exceeded', `nesting exceeds ${WORDPRESS_MAX_DEPTH} levels`);
        }
        addInnerBlock(block, token.start, token.end);
      }
      offset = token.end;
      continue;
    }

    if (token.kind === 'closer') {
      if (stack.length === 0) {
        addFreeform();
        break;
      }
      if (stack.length === 1) {
        addBlockFromStack(token.start);
        offset = token.end;
        continue;
      }
      const top = stack.pop();
      if (!top) break;
      const gap = html.slice(top.prevOffset, token.start);
      if (gap) {
        checkRawHtml(top.block.innerHTML + gap);
        top.block.innerHTML += gap;
        top.block.innerContent.push(gap);
      }
      top.prevOffset = token.end;
      addInnerBlock(top.block, top.tokenStart, token.end);
      offset = token.end;
      continue;
    }

    if (stack.length + 1 > WORDPRESS_MAX_DEPTH) {
      throw new WordPressAdapterError('max_depth_exceeded', `nesting exceeds ${WORDPRESS_MAX_DEPTH} levels`);
    }
    budget(1);
    stack.push({
      block: makeBlock(token),
      tokenStart: token.start,
      prevOffset: token.end,
      leadingHtmlStart,
    });
    offset = token.end;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Entities + inline HTML
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const num = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(num) && num >= 0 && num <= 0x10ffff) return String.fromCodePoint(num);
      return match;
    }
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'nbsp':
        return '\u00a0';
      default:
        return match;
    }
  });
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

interface RawTag {
  raw: string;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Record<string, string>;
  end: number;
}

function readTagAt(html: string, start: number): RawTag | null {
  if (html.charAt(start) !== '<') return null;
  if (html.startsWith('<!--', start) || html.startsWith('<!', start) || html.startsWith('<?', start)) return null;
  let i = start + 1;
  let closing = false;
  if (html.charAt(i) === '/') {
    closing = true;
    i += 1;
  }
  const nameStart = i;
  if (!/[A-Za-z]/.test(html.charAt(i))) return null;
  i += 1;
  while (i < html.length && /[A-Za-z0-9:_-]/.test(html.charAt(i))) i += 1;
  const name = html.slice(nameStart, i);

  const attrs: Record<string, string> = {};
  let selfClosing = false;
  for (;;) {
    while (i < html.length && isSpace(html.charAt(i))) i += 1;
    if (i >= html.length) return null;
    const ch = html.charAt(i);
    if (ch === '>') {
      i += 1;
      break;
    }
    if (ch === '/' && html.charAt(i + 1) === '>') {
      selfClosing = true;
      i += 2;
      break;
    }
    const attrStart = i;
    while (i < html.length && !/[\s=>]/.test(html.charAt(i))) i += 1;
    const attrName = html.slice(attrStart, i).toLowerCase();
    if (attrName.length === 0) {
      i += 1;
      continue;
    }
    while (i < html.length && isSpace(html.charAt(i))) i += 1;
    if (html.charAt(i) !== '=') {
      attrs[attrName] = '';
      continue;
    }
    i += 1;
    while (i < html.length && isSpace(html.charAt(i))) i += 1;
    const quote = html.charAt(i);
    if (quote === '"' || quote === "'") {
      i += 1;
      const valueStart = i;
      while (i < html.length && html.charAt(i) !== quote) i += 1;
      const value = html.slice(valueStart, i);
      if (html.charAt(i) === quote) i += 1;
      attrs[attrName] = value;
    } else {
      const valueStart = i;
      while (i < html.length && !/[\s>]/.test(html.charAt(i))) i += 1;
      attrs[attrName] = html.slice(valueStart, i);
    }
  }
  return { raw: html.slice(start, i), name, closing, selfClosing, attrs, end: i };
}

const INLINE_MARK_BY_TAG: Record<string, string> = {
  strong: 'bold',
  b: 'bold',
  em: 'italic',
  i: 'italic',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
  code: 'code',
};

function applyInlineTag(tag: RawTag, out: CanonicalInline[], marks: CanonicalMark[]): void {
  const name = tag.name.toLowerCase();
  const markType = INLINE_MARK_BY_TAG[name];

  if (!tag.closing && !tag.selfClosing && name === 'br') {
    out.push({ type: 'break' });
    return;
  }
  if (name === 'br') return;

  if (tag.closing) {
    if (markType) {
      for (let k = marks.length - 1; k >= 0; k -= 1) {
        if (marks[k]?.type === markType) {
          marks.splice(k, 1);
          return;
        }
      }
      return;
    }
    if (name === 'a') {
      for (let k = marks.length - 1; k >= 0; k -= 1) {
        if (marks[k]?.type === 'link') {
          marks.splice(k, 1);
          return;
        }
      }
    }
    out.push({ type: 'inlineUnsupported', raw: tag.raw, source: { cms: 'wordpress', type: name } });
    return;
  }

  if (markType) {
    if (!tag.selfClosing) marks.push({ type: markType });
    return;
  }

  if (name === 'a') {
    const href = tag.attrs.href;
    if (!tag.selfClosing && typeof href === 'string' && href.length > 0) {
      const markAttrs: Record<string, unknown> = { href: decodeEntities(href) };
      if (tag.attrs.target) markAttrs.target = decodeEntities(tag.attrs.target);
      if (tag.attrs.rel) markAttrs.rel = decodeEntities(tag.attrs.rel);
      marks.push({ type: 'link', attrs: markAttrs });
      return;
    }
  }

  out.push({ type: 'inlineUnsupported', raw: tag.raw, source: { cms: 'wordpress', type: name } });
}

function parseInline(html: string): CanonicalInline[] {
  const out: CanonicalInline[] = [];
  const marks: CanonicalMark[] = [];
  let textStart = 0;
  let i = 0;

  const flush = (end: number): void => {
    if (end <= textStart) return;
    const text = decodeEntities(html.slice(textStart, end));
    if (text.length === 0) return;
    out.push(marks.length > 0 ? { type: 'text', text, marks: marks.map((m) => (m.attrs ? { type: m.type, attrs: { ...m.attrs } } : { type: m.type })) } : { type: 'text', text });
  };

  while (i < html.length) {
    if (html.charAt(i) !== '<') {
      i += 1;
      continue;
    }
    const tag = readTagAt(html, i);
    if (!tag) {
      i += 1;
      continue;
    }
    flush(i);
    applyInlineTag(tag, out, marks);
    i = tag.end;
    textStart = i;
  }
  flush(html.length);
  return out;
}

const MARK_WRAP: Record<string, (inner: string) => string> = {
  bold: (inner) => `<strong>${inner}</strong>`,
  italic: (inner) => `<em>${inner}</em>`,
  strike: (inner) => `<s>${inner}</s>`,
  code: (inner) => `<code>${inner}</code>`,
  underline: (inner) => `<u>${inner}</u>`,
  sub: (inner) => `<sub>${inner}</sub>`,
  sup: (inner) => `<sup>${inner}</sup>`,
};

function renderMark(mark: CanonicalMark, inner: string): string {
  if (mark.type === 'link') {
    const attrs = mark.attrs ?? {};
    const href = typeof attrs.href === 'string' ? attrs.href : '';
    let out = `<a href="${escapeAttr(href)}"`;
    if (typeof attrs.target === 'string') out += ` target="${escapeAttr(attrs.target)}"`;
    if (typeof attrs.rel === 'string') out += ` rel="${escapeAttr(attrs.rel)}"`;
    return `${out}>${inner}</a>`;
  }
  const wrap = MARK_WRAP[mark.type];
  return wrap ? wrap(inner) : inner;
}

function renderInline(inline: CanonicalInline[] | undefined): string {
  if (!inline || inline.length === 0) return '';
  let out = '';
  for (const node of inline) {
    if (node.type === 'text') {
      let html = escapeText(node.text);
      const marks = node.marks ?? [];
      for (let k = marks.length - 1; k >= 0; k -= 1) {
        const mark = marks[k];
        if (mark) html = renderMark(mark, html);
      }
      out += html;
    } else if (node.type === 'break') {
      out += '<br>';
    } else {
      out += node.raw ?? '';
    }
  }
  return out;
}

function plainTextOf(inline: CanonicalInline[] | undefined): string {
  if (!inline) return '';
  let out = '';
  for (const node of inline) if (node.type === 'text') out += node.text;
  return out;
}

// ---------------------------------------------------------------------------
// Canonical projection
// ---------------------------------------------------------------------------

const WP_TO_CANONICAL: Record<string, string> = {
  'core/paragraph': 'paragraph',
  'core/heading': 'heading',
  'core/list': 'list',
  'core/list-item': 'listItem',
  'core/quote': 'quote',
  'core/code': 'code',
  'core/image': 'image',
  'core/separator': 'divider',
  'core/group': 'group',
  'core/columns': 'columns',
  'core/column': 'column',
  'core/table': 'table',
  'core/table-row': 'tableRow',
  'core/table-cell': 'tableCell',
};

const CANONICAL_TO_WP: Record<string, string> = {
  paragraph: 'core/paragraph',
  heading: 'core/heading',
  list: 'core/list',
  listItem: 'core/list-item',
  quote: 'core/quote',
  code: 'core/code',
  image: 'core/image',
  divider: 'core/separator',
  group: 'core/group',
  columns: 'core/columns',
  column: 'core/column',
  table: 'core/table',
  tableRow: 'core/table-row',
  tableCell: 'core/table-cell',
};

function unwrapElement(html: string, names: readonly string[]): string {
  const lower = html.toLowerCase();
  for (const name of names) {
    const open = new RegExp(`^\\s*<${name}(?:\\s[^>]*)?>`, 'i').exec(html);
    if (!open) continue;
    const close = `</${name}>`;
    const closeIndex = lower.lastIndexOf(close);
    if (closeIndex >= open[0].length) return html.slice(open[0].length, closeIndex);
  }
  return html;
}

function headingLevel(attrs: Record<string, unknown> | undefined): number {
  const level = attrs?.level;
  if (typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6) return level;
  return 2;
}

function listOrdered(block: WpBlock): boolean {
  const raw = block.attrs?.ordered;
  if (typeof raw === 'boolean') return raw;
  return /<ol(?=[\s>])/i.test(block.innerHTML);
}

function extractListItems(html: string): string[] {
  const out: string[] = [];
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) out.push(match[1] ?? '');
  return out;
}

function extractCells(html: string): string[] {
  const out: string[] = [];
  const re = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) out.push(match[2] ?? '');
  return out;
}

function codeText(html: string): string {
  const match = /<code\b[^>]*>([\s\S]*?)<\/code>/i.exec(html);
  return decodeEntities(stripTags(match ? (match[1] ?? '') : html));
}

function imageAttrs(block: WpBlock): Record<string, unknown> | undefined {
  const attrs: Record<string, unknown> = {};
  const raw = block.attrs ?? {};
  if (raw.id !== undefined && raw.id !== null) attrs.mediaId = String(raw.id);

  const img = /<img\b[^>]*>/i.exec(block.innerHTML);
  if (img) {
    const tag = readTagAt(block.innerHTML, img.index);
    if (tag) {
      if (tag.attrs.src) attrs.src = decodeEntities(tag.attrs.src);
      if (tag.attrs.alt !== undefined) attrs.alt = decodeEntities(tag.attrs.alt);
      const width = tag.attrs.width !== undefined ? Number(tag.attrs.width) : Number.NaN;
      const height = tag.attrs.height !== undefined ? Number(tag.attrs.height) : Number.NaN;
      if (Number.isFinite(width)) attrs.width = width;
      if (Number.isFinite(height)) attrs.height = height;
    }
  }
  if (typeof raw.width === 'number') attrs.width = raw.width;
  if (typeof raw.height === 'number') attrs.height = raw.height;

  const caption = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(block.innerHTML);
  if (caption) attrs.caption = decodeEntities(stripTags(caption[1] ?? ''));

  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function buildSource(block: WpBlock): SourceRef {
  const source: SourceRef = { cms: 'wordpress', type: block.blockName ?? 'html' };
  if (block.attrs && Object.keys(block.attrs).length > 0) source.attrs = block.attrs;
  if (block.attrsRaw !== null) source.attrsRaw = block.attrsRaw;
  if (block.innerContent.length > 0) source.innerContent = block.innerContent;
  return source;
}

function projectBlock(block: WpBlock): CanonicalBlock {
  if (block.blockName === null) {
    return { type: 'html', rawHtml: block.innerHTML };
  }

  const source = buildSource(block);
  const canonicalType = WP_TO_CANONICAL[block.blockName] ?? 'custom';
  const children = block.innerBlocks.length > 0 ? block.innerBlocks.map(projectBlock) : undefined;
  const out: CanonicalBlock = { type: canonicalType, source };

  switch (canonicalType) {
    case 'paragraph': {
      const content = parseInline(unwrapElement(block.innerHTML, ['p']));
      if (content.length > 0) out.content = content;
      break;
    }
    case 'heading': {
      out.attrs = { level: headingLevel(block.attrs ?? undefined) };
      const content = parseInline(unwrapElement(block.innerHTML, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']));
      if (content.length > 0) out.content = content;
      break;
    }
    case 'list': {
      const ordered = listOrdered(block);
      const attrs: Record<string, unknown> = { ordered };
      const start = block.attrs?.start;
      if (ordered && typeof start === 'number' && Number.isInteger(start)) attrs.start = start;
      out.attrs = attrs;
      if (children) out.children = children;
      else {
        const items = extractListItems(block.innerHTML);
        if (items.length > 0) out.children = items.map((item) => ({ type: 'listItem', content: parseInline(item) }));
      }
      break;
    }
    case 'listItem': {
      if (children) out.children = children;
      else {
        const content = parseInline(unwrapElement(block.innerHTML, ['li']));
        if (content.length > 0) out.content = content;
      }
      break;
    }
    case 'quote':
      if (children) out.children = children;
      break;
    case 'code': {
      const language = block.attrs?.language;
      if (typeof language === 'string') out.attrs = { language };
      const text = codeText(block.innerHTML);
      if (text.length > 0) out.content = [{ type: 'text', text }];
      break;
    }
    case 'image': {
      const attrs = imageAttrs(block);
      if (attrs) out.attrs = attrs;
      break;
    }
    case 'divider':
      break;
    case 'table':
      if (children) out.children = children;
      break;
    case 'tableRow': {
      if (children) out.children = children;
      else {
        const cells = extractCells(block.innerHTML);
        if (cells.length > 0) out.children = cells.map((cell) => ({ type: 'tableCell', content: parseInline(cell) }));
      }
      break;
    }
    case 'tableCell': {
      if (children) out.children = children;
      else {
        const content = parseInline(unwrapElement(block.innerHTML, ['td', 'th']));
        if (content.length > 0) out.content = content;
      }
      break;
    }
    case 'group':
    case 'columns':
    case 'column':
      if (children) out.children = children;
      break;
    default: {
      if (block.attrs && Object.keys(block.attrs).length > 0) out.attrs = block.attrs;
      if (children) out.children = children;
      break;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public API: parse
// ---------------------------------------------------------------------------

/**
 * Parses WordPress `post_content` block markup into a canonical document.
 *
 * Malformed markup and malformed attribute JSON are tolerated and preserved as
 * far as the canonical model allows. Hard safety-budget overflows throw a
 * {@link WordPressAdapterError} instead of truncating content.
 */
export function parseWordPressBlocks(html: string): CanonicalDocument {
  const input = typeof html === 'string' ? html : '';
  const blocks = parseWpBlocks(input).map(projectBlock);
  return { version: CANONICAL_DOCUMENT_VERSION, blocks };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** WordPress block comments omit the default `core/` namespace. */
function commentName(name: string): string {
  return name.startsWith('core/') ? name.slice('core/'.length) : name;
}

function pair(name: string, attrsJson: string, body: string): string {
  const short = commentName(name);
  return `<!-- wp:${short}${attrsJson} -->${body}<!-- /wp:${short} -->`;
}

function voidBlock(name: string, attrsJson: string): string {
  return `<!-- wp:${commentName(name)}${attrsJson} /-->`;
}

function renderChildren(block: CanonicalBlock): string {
  return (block.children ?? []).map(renderBlockToWp).join('');
}

function figureHtml(attrs: Record<string, unknown> | undefined): string {
  const a = attrs ?? {};
  const src = typeof a.src === 'string' ? a.src : '';
  const alt = typeof a.alt === 'string' ? a.alt : '';
  const dims =
    (typeof a.width === 'number' ? ` width="${a.width}"` : '') +
    (typeof a.height === 'number' ? ` height="${a.height}"` : '');
  const caption = typeof a.caption === 'string' && a.caption.length > 0 ? `<figcaption>${escapeText(a.caption)}</figcaption>` : '';
  return `<figure class="wp-block-image"><img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${dims}/>${caption}</figure>`;
}

function semanticAttrsForWp(block: CanonicalBlock): Record<string, unknown> | undefined {
  if (block.type === 'heading') return { level: headingLevel(block.attrs) };
  return undefined;
}

function renderSemanticBlock(block: CanonicalBlock, name: string, attrsJson: string): string {
  switch (block.type) {
    case 'paragraph':
      return pair(name, attrsJson, `<p>${renderInline(block.content)}</p>`);
    case 'heading': {
      const level = headingLevel(block.attrs);
      return pair(name, attrsJson, `<h${level} class="wp-block-heading">${renderInline(block.content)}</h${level}>`);
    }
    case 'code':
      return pair(name, attrsJson, `<pre class="wp-block-code"><code>${escapeText(plainTextOf(block.content))}</code></pre>`);
    case 'image':
      return pair(name, attrsJson, figureHtml(block.attrs));
    case 'divider':
      return voidBlock(name, attrsJson);
    case 'list': {
      const ordered = block.attrs?.ordered === true;
      const tag = ordered ? 'ol' : 'ul';
      return pair(name, attrsJson, `<${tag} class="wp-block-list">${renderChildren(block)}</${tag}>`);
    }
    case 'listItem': {
      const inner = renderChildren(block) || renderInline(block.content);
      return pair(name, attrsJson, `<li>${inner}</li>`);
    }
    case 'quote':
      return pair(
        name,
        attrsJson,
        `<blockquote class="wp-block-quote">${renderChildren(block) || (block.content ? `<p>${renderInline(block.content)}</p>` : '')}</blockquote>`,
      );
    case 'group':
      return pair(name, attrsJson, `<div class="wp-block-group">${renderChildren(block)}</div>`);
    case 'columns':
      return pair(name, attrsJson, `<div class="wp-block-columns">${renderChildren(block)}</div>`);
    case 'column':
      return pair(name, attrsJson, `<div class="wp-block-column">${renderChildren(block)}</div>`);
    case 'table':
      return pair(name, attrsJson, `<figure class="wp-block-table"><table><tbody>${renderChildren(block)}</tbody></table></figure>`);
    case 'tableRow':
      return pair(name, attrsJson, `<tr>${renderChildren(block)}</tr>`);
    case 'tableCell':
      return pair(name, attrsJson, `<td>${renderChildren(block) || renderInline(block.content)}</td>`);
    default:
      if (block.rawHtml !== undefined) return block.rawHtml;
      if (block.children && block.children.length > 0) return pair(name, attrsJson, renderChildren(block));
      if (block.content && block.content.length > 0) return pair(name, attrsJson, `<p>${renderInline(block.content)}</p>`);
      return voidBlock(name, attrsJson);
  }
}

function renderBlockToWp(block: CanonicalBlock): string {
  const source = block.source && block.source.cms === 'wordpress' ? block.source : undefined;

  if (block.type === 'html' && !source) return block.rawHtml ?? '';

  const name = source?.type ?? CANONICAL_TO_WP[block.type];
  if (!name) {
    if (block.rawHtml !== undefined) return block.rawHtml;
    if (block.children && block.children.length > 0) return renderChildren(block);
    if (block.content && block.content.length > 0) return pair('core/paragraph', '', `<p>${renderInline(block.content)}</p>`);
    return '';
  }

  const attrs = source ? source.attrs : semanticAttrsForWp(block);
  const attrsJson =
    source && source.attrsRaw !== undefined
      ? ` ${source.attrsRaw}`
      : attrs && Object.keys(attrs).length > 0
        ? ` ${JSON.stringify(attrs)}`
        : '';

  if (source && source.innerContent && source.innerContent.length > 0) {
    const children = block.children ?? [];
    let childIndex = 0;
    const body = source.innerContent
      .map((part) => {
        if (part !== null) return part;
        const child = children[childIndex];
        childIndex += 1;
        return child ? renderBlockToWp(child) : '';
      })
      .join('');
    return pair(name, attrsJson, body);
  }

  return renderSemanticBlock(block, name, attrsJson);
}

/**
 * Serializes a canonical document back to WordPress block markup. Documents
 * produced by {@link parseWordPressBlocks} serialize byte-exactly from their
 * preserved `source`; other documents are rendered from their semantic blocks.
 */
export function serializeWordPressBlocks(doc: CanonicalDocument): string {
  const blocks = doc && Array.isArray(doc.blocks) ? doc.blocks : [];
  return blocks.map(renderBlockToWp).join('');
}
