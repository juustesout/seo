/**
 * The canonical revision/dirty contract for an open editor document (R5.2.3).
 *
 * Two revisions exist because the app has two genuinely different questions,
 * and both are derived from one stable hash (`contentRevisionOf`) so they can
 * never drift into two incompatible revision systems:
 *
 *   - `documentRevisionOf(doc)` is the revision of the document content alone.
 *     It is the concurrency token: the server derives the same token from the
 *     persisted `content_json`, and the editor apply guards compare against it.
 *
 *   - `workspaceRevisionOf(state)` is the revision of the whole persisted unit:
 *     the document revision plus the editable metadata (title, status, target
 *     keyword, meta title/description). It is what autosave compares against
 *     its baseline, because persisting the workspace writes those fields too;
 *     a metadata-only edit must dirty the workspace even though the document
 *     revision is unchanged.
 *
 * `workspaceRevisionOf` embeds `documentRevisionOf`, so a document change
 * always changes the workspace revision; the reverse is not true, which is the
 * documented distinction. `workspaceSnapshotOf` is the canonical JSON payload
 * autosave persists; its document projection is `documentRevisionOf`.
 */
import { contentRevisionOf, type TipDoc } from '@seo/contracts';

/** Canonical revision of a document's content only (the concurrency token). */
export function documentRevisionOf(doc: TipDoc): string {
  return contentRevisionOf(doc);
}

/** The editable fields that make up one persisted workspace unit. */
export interface WorkspaceDocumentState {
  doc: TipDoc;
  title: string;
  status: string;
  targetKeyword: string;
  metaTitle: string;
  metaDescription: string;
}

/**
 * Canonical JSON payload for one workspace snapshot. Autosave persists this
 * verbatim (the server parses the same keys back out), so it stays a string
 * rather than a hash token.
 */
export function workspaceSnapshotOf(state: WorkspaceDocumentState): string {
  return JSON.stringify({
    t: state.title,
    s: state.status,
    d: state.doc,
    k: state.targetKeyword,
    mt: state.metaTitle,
    md: state.metaDescription,
  });
}

/**
 * Canonical revision of the whole persisted workspace unit. Defined over the
 * document revision (not the raw document) so the document token is the single
 * source of truth for document changes.
 */
export function workspaceRevisionOf(state: WorkspaceDocumentState): string {
  return contentRevisionOf({
    document: documentRevisionOf(state.doc),
    metadata: {
      title: state.title,
      status: state.status,
      targetKeyword: state.targetKeyword,
      metaTitle: state.metaTitle,
      metaDescription: state.metaDescription,
    },
  });
}
