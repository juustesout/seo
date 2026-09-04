/**
 * Structured content model.
 *
 * Content is stored as an ordered list of typed blocks (source of truth).
 * HTML is always a render of those blocks, produced by this module so the UI,
 * the API and the content agent share one implementation.
 */

export type ContentHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type MediaKind = 'image' | 'video' | 'audio' | 'placeholder';

export type ContentBlock =
  | { id?: string; type: 'heading'; attrs: { level: ContentHeadingLevel; text: string } }
  | { id?: string; type: 'paragraph'; attrs: { text: string } }
  | { id?: string; type: 'list'; attrs: { ordered?: boolean; items: string[] } }
  | { id?: string; type: 'quote'; attrs: { text: string; cite?: string } }
  | { id?: string; type: 'code'; attrs: { text: string } }
  | {
      id?: string;
      type: 'media';
      attrs: { kind: MediaKind; src?: string; alt?: string; caption?: string };
    }
  | { id?: string; type: 'link'; attrs: { text: string; href: string } };

export interface ContentOutlineItem {
  level: ContentHeadingLevel;
  text: string;
}

/** Blocks that represent a single empty paragraph (no content yet). */
export function emptyBlocks(): ContentBlock[] {
  return [{ type: 'paragraph', attrs: { text: '' } }];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render blocks to semantic HTML. Escapes all authored text. */
export function renderContentHtml(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, block.attrs.level)) as ContentHeadingLevel;
        parts.push(`<h${level}>${escapeHtml(block.attrs.text)}</h${level}>`);
        break;
      }
      case 'paragraph':
        if (block.attrs.text.trim()) {
          parts.push(`<p>${escapeHtml(block.attrs.text)}</p>`);
        }
        break;
      case 'list': {
        const tag = block.attrs.ordered ? 'ol' : 'ul';
        const items = block.attrs.items
          .filter((i) => i.trim())
          .map((i) => `<li>${escapeHtml(i)}</li>`)
          .join('');
        parts.push(`<${tag}>${items}</${tag}>`);
        break;
      }
      case 'quote': {
        const cite = block.attrs.cite ? `<cite>${escapeHtml(block.attrs.cite)}</cite>` : '';
        parts.push(`<blockquote>${escapeHtml(block.attrs.text)}${cite}</blockquote>`);
        break;
      }
      case 'code':
        parts.push(`<pre><code>${escapeHtml(block.attrs.text)}</code></pre>`);
        break;
      case 'media': {
        const caption = block.attrs.caption
          ? `<figcaption>${escapeHtml(block.attrs.caption)}</figcaption>`
          : '';
        if (block.attrs.kind === 'image' && block.attrs.src) {
          parts.push(
            `<figure class="seo-media"><img src="${escapeHtml(block.attrs.src)}" alt="${escapeHtml(block.attrs.alt ?? '')}" />${caption}</figure>`,
          );
        } else {
          const label =
            block.attrs.kind === 'placeholder'
              ? `[media placeholder: ${escapeHtml(block.attrs.alt ?? 'image')}]`
              : `[${escapeHtml(block.attrs.kind)}: ${escapeHtml(block.attrs.alt ?? block.attrs.src ?? '')}]`;
          parts.push(`<figure class="seo-media" data-media-placeholder="${escapeHtml(block.attrs.kind)}">${label}${caption}</figure>`);
        }
        break;
      }
      case 'link':
        parts.push(`<p><a href="${escapeHtml(block.attrs.href)}">${escapeHtml(block.attrs.text)}</a></p>`);
        break;
      default:
        break;
    }
  }
  return parts.join('\n');
}

/** Outline derived from heading blocks (used for navigation and briefs). */
export function contentOutline(blocks: ContentBlock[]): ContentOutlineItem[] {
  const items: ContentOutlineItem[] = [];
  for (const block of blocks) {
    if (block.type === 'heading' && block.attrs.text.trim()) {
      items.push({ level: block.attrs.level, text: block.attrs.text.trim() });
    }
  }
  return items;
}

/** Word count of all text blocks (rough, for length signals). */
export function contentWordCount(blocks: ContentBlock[]): number {
  let words = 0;
  for (const block of blocks) {
    if (block.type === 'paragraph' || block.type === 'heading') {
      words += block.attrs.text.split(/\s+/).filter(Boolean).length;
    } else if (block.type === 'quote' || block.type === 'code' || block.type === 'link') {
      words += block.attrs.text.split(/\s+/).filter(Boolean).length;
    } else if (block.type === 'list') {
      words += block.attrs.items.reduce((acc, i) => acc + i.split(/\s+/).filter(Boolean).length, 0);
    }
  }
  return words;
}

/** URL-safe slug from a title/string. */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
