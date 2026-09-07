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

/**
 * Strip a basic HTML fragment down to readable plain text. Blocks (p/div/
 * headings/lists/quotes) become newlines so the plain post keeps paragraph
 * structure; inline tags collapse to spaces; a handful of common entities are
 * decoded. This is deliberately conservative - it targets the HTML our own
 * content renderer produces (see renderDocHtml) - not a full HTML parser, and
 * it never tries to be X/WordPress specific.
 */
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

/**
 * Best-effort markdown-to-plain-text cleanup: images drop entirely, links keep
 * their label (the URL would only eat scarce characters on a text channel),
 * ATX headings/emphasis/blockquotes/lists/horizontal rules lose their markers.
 * The regexes match the markdown we emit; content that is not markdown-shaped
 * passes through mostly untouched.
 */
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

/**
 * Decide how to interpret the incoming content body. The declared
 * contentFormat wins; when none is declared we sniff: text containing real
 * markup tags is treated as HTML (publication snapshots store the content as
 * HTML), anything else as markdown (manual/managed entries). Sniffing beats a
 * hard default because wrongly running markdown strip-patterns over HTML (or
 * vice versa) would corrupt the post.
 */
function pickContent(input: PublishInput): { body: string; source: 'html' | 'markdown' | 'plain' } {
  const content = input.content ?? '';
  if (input.contentFormat === 'plain') return { body: content, source: 'plain' };
  if (input.contentFormat === 'markdown') return { body: content, source: 'markdown' };
  // Undeclared content: trust it as HTML only when it actually contains tags
  // (publication snapshots are HTML renders; manual entries may be plain/markdown).
  if (/<\/?[a-z][\s\S]*>/i.test(content)) return { body: content, source: 'html' };
  return { body: content, source: 'markdown' };
}

/** Convert the picked source representation to plain text. */
function toPlainText(input: PublishInput): string {
  const { body, source } = pickContent(input);
  if (source === 'html') return htmlToText(body);
  if (source === 'markdown') return markdownToText(body);
  return body;
}

/**
 * Normalize whitespace to single spaces per line, dropping blank lines, so a
 * multiline article body compresses to a readable short post instead of
 * shipping raw formatting artifacts.
 */
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
 * intent. Composition dedup rules (why each guard exists):
 *   - title is skipped when it equals the excerpt (no "Headline\n\nHeadline").
 *   - body is skipped when it equals the excerpt (same duplicate body).
 * Parts are joined by a blank line so a channel that renders newlines keeps
 * the title/excerpt visually separated from the body.
 *
 * `maxChars` truncation with a trailing ellipsis is a *pre-shaping* cap at a
 * generous default (5000): it exists so one pathological body cannot produce a
 * megabyte post, not to decide channel validity. Platform-exact counting is
 * the adapter's job - e.g. the X adapter re-counts with X's own rules
 * (xPostCharacterCount) and refuses anything over 280 with a clear error
 * instead of silently auto-truncating, because auto-truncation would mislead
 * the user about what actually got posted.
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
