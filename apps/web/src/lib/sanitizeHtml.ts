/**
 * Defense-in-depth sanitizer for server-rendered article HTML.
 *
 * `content_html` is produced server-side from structured content, but it is
 * injected into the DOM with `dangerouslySetInnerHTML` and may originate from
 * older records or AI drafts. This module parses that HTML with `DOMParser`
 * (which does not execute scripts), drops elements/attributes that can run
 * script, and rewrites link/image URLs through a scheme allowlist so a
 * `javascript:`/`data:` payload can never reach a clickable anchor.
 */

import { safeHref } from '@seo/contracts';

/** Element names kept as-is. Anything else is either removed (active content) or unwrapped. */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'strong', 'em', 'b', 'i', 's', 'u', 'sub', 'sup', 'mark', 'small',
  'span', 'div', 'section', 'article',
  'figure', 'figcaption', 'img', 'a',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
]);

/** Elements whose entire subtree is removed rather than unwrapped. */
const DROPPED_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'link', 'meta', 'base', 'title', 'head',
  'form', 'input', 'textarea', 'select', 'option', 'button', 'svg', 'math',
]);

/** Per-element attribute allowlist (class + data-* are always permitted). */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height', 'loading']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
};

const DANGEROUS_ATTRS = new Set(['srcdoc', 'formaction', 'background', 'xlink:href', 'style']);

/** Data-URI image types safe to inline; SVG is excluded (it can carry script). */
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i;

/** Allow only http(s)/relative and safe inline-image sources. */
export function safeImageSrc(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const src = value.trim();
  if (!src) return undefined;
  if (src.startsWith('/')) return src;
  if (/^https?:\/\//i.test(src)) return src;
  if (SAFE_DATA_IMAGE.test(src)) return src;
  return undefined;
}

function isSafeDataAttr(name: string): boolean {
  return name.startsWith('data-');
}

function sanitizeElement(el: Element): void {
  const tag = el.tagName.toLowerCase();
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on') || DANGEROUS_ATTRS.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'class' || isSafeDataAttr(name)) continue;
    if (name === 'href') {
      const safe = safeHref(attr.value);
      if (safe) el.setAttribute(attr.name, safe);
      else el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'src') {
      const safe = safeImageSrc(attr.value);
      if (safe) el.setAttribute(attr.name, safe);
      else el.removeAttribute(attr.name);
      continue;
    }
    const allowed = ALLOWED_ATTRS[tag];
    if (!allowed || !allowed.has(name)) el.removeAttribute(attr.name);
  }
  if (tag === 'a' && el.getAttribute('target') === '_blank') {
    el.setAttribute('rel', 'noopener noreferrer');
  }
}

function walk(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 8) {
      child.remove();
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROPPED_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      while (el.firstChild) node.insertBefore(el.firstChild, el);
      el.remove();
      continue;
    }
    sanitizeElement(el);
    walk(el);
  }
}

/**
 * Return a script-free rendering of `html`. When no DOM is available (e.g. a
 * server render pass) the input is dropped rather than injected unsanitized.
 */
export function sanitizeArticleHtml(html: string | null | undefined): string {
  if (!html) return '';
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  walk(doc.body);
  return doc.body.innerHTML;
}
