import type { ContentAiAction, ContentAiSuggestionDto } from '@seo/contracts';

export const AI_ACTION_LABELS: Record<ContentAiAction, string> = {
  rewrite: 'Rewrite',
  improve: 'Improve',
  expand: 'Expand',
  shorten: 'Shorten',
  tone: 'Change tone',
  improve_seo: 'Improve for SEO',
  generate_section: 'Generate section',
};

export const SELECTION_ACTIONS: ContentAiAction[] = [
  'rewrite',
  'improve',
  'expand',
  'shorten',
  'tone',
  'improve_seo',
];

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Converts plain AI copy into block HTML for Tiptap. Lines starting with "## "
 * become H2 headings, everything else becomes paragraphs split on blank lines.
 */
export function textToBlocksHtml(text: string): string {
  const raw = text.replace(/\r\n/g, '\n').trim();
  if (!raw) return '<p></p>';
  const paragraphs = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return '<p></p>';
  return paragraphs
    .map((p) => {
      const heading = p.match(/^#{2,3}\s+(.+)$/);
      const headingText = heading ? heading[1] : undefined;
      if (headingText) {
        return `<h2>${escapeHtml(headingText.trim())}</h2>`;
      }
      return `<p>${escapeHtml(p)}</p>`;
    })
    .join('');
}

export function firstBlock(editor: { state: { selection: { from: number; to: number; empty: boolean } } }) {
  const { empty, from, to } = editor.state.selection;
  return empty || from >= to ? null : { from, to };
}

export type { ContentAiAction, ContentAiSuggestionDto };
