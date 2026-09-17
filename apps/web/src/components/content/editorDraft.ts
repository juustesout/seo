/**
 * Content Studio draft from a composed CanonicalDocument (Stage 8D).
 *
 * Turns a Compose preview into the exact shape the existing Content Studio
 * create endpoint accepts: a title plus a Tiptap document. The block conversion
 * is delegated to the shared `canonicalDocumentToEditorDocument` adapter, so the
 * editor representation is defined once. The title follows the existing content
 * model (`seo_content.title`, max 300 chars): the document's primary heading is
 * used when present, otherwise the caller's brief. Nothing is generated here and
 * the source document is never mutated.
 */

import {
  canonicalDocumentToEditorDocument,
  docHeadings,
  type CanonicalDocument,
  type TipDoc,
} from '@seo/contracts';

/** Mirrors the API's `title` bound (`contentInputSchema`). */
export const CONTENT_TITLE_MAX_CHARS = 300;

export interface EditorContentDraft {
  title: string;
  doc: TipDoc;
}

/** Primary heading text of an editor document, or null when it has none. */
export function primaryHeadingText(doc: TipDoc): string | null {
  const headings = docHeadings(doc);
  const primary = headings.find((heading) => heading.level === 1) ?? headings[0];
  const text = primary?.text.trim() ?? '';
  return text.length > 0 ? text : null;
}

/**
 * Builds the create-payload draft for a composed document. `fallbackTitle` is
 * the user's brief, used only when the document carries no heading text.
 */
export function editorDraftFromCanonical(document: CanonicalDocument, fallbackTitle: string): EditorContentDraft {
  const doc = canonicalDocumentToEditorDocument(document);
  const title = (primaryHeadingText(doc) ?? fallbackTitle).trim().slice(0, CONTENT_TITLE_MAX_CHARS).trim();
  return { title: title.length > 0 ? title : 'Untitled', doc };
}
