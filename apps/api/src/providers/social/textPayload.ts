/**
 * Social text payload builder (Content Studio Phase H5).
 *
 * Transforms canonical content (title / excerpt / content) into a plain-text
 * post the way a text-capable social adapter needs it. Adapters own their own
 * platform transformation and call this builder with the canonical payload the
 * worker already resolves; nothing here talks to a network or stores state.
 */

import type { PublishInput } from '@seo/contracts';

export interface SocialTextPost {
  text: string;
}

/** Strip a basic HTML fragment down to readable plain text. */
export function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Best-effort markdown-to-plain-text cleanup (titles, emphasis, links). */
export function markdownToText(markdown: string): string {
  return String(markdown ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^---+$/gm, '');
}

function pickContent(input: PublishInput): { body: string; source: 'html' | 'markdown' | 'plain' } {
  const content = input.content ?? '';
  if (input.contentFormat === 'plain') return { body: content, source: 'plain' };
  if (input.contentFormat === 'markdown') return { body: content, source: 'markdown' };
  // Undeclared content: trust it as HTML only when it actually contains tags
  // (publication snapshots are HTML renders; manual entries may be plain/markdown).
  if (/<\/?[a-z][\s\S]*>/i.test(content)) return { body: content, source: 'html' };
  return { body: content, source: 'markdown' };
}

function toPlainText(input: PublishInput): string {
  const { body, source } = pickContent(input);
  if (source === 'html') return htmlToText(body);
  if (source === 'markdown') return markdownToText(body);
  return body;
}

function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Build the plain-text social post from canonical content. The post composes
 * the title + excerpt/body so short text channels still carry the article
 * intent; truncation to maxChars is enforced at the very end.
 */
export function buildSocialTextPost(input: PublishInput, options: { maxChars?: number } = {}): SocialTextPost {
  const maxChars = options.maxChars ?? 5000;
  const title = (input.title ?? '').trim();
  const excerpt = (input.excerpt ?? '').trim();
  const body = normalizeWhitespace(toPlainText(input));

  const parts: string[] = [];
  if (title && title.toLowerCase() !== excerpt.toLowerCase()) parts.push(title);
  if (excerpt) parts.push(excerpt);
  if (body && body !== excerpt) parts.push(body);
  let text = parts.join('\n\n');

  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 1).replace(/\s+\S*$/, '') + '…';
  }
  return { text };
}
