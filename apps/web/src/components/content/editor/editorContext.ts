/**
 * Editor context foundation (R1.2).
 *
 * A single, normalized, document-scoped snapshot of the editor for future
 * Editor-native features (the embedded Designer agent in R2/R3, contextual
 * actions in R5). Features read this instead of reaching into the Tiptap
 * instance or re-deriving identity/revision/selection from scattered props.
 *
 * This module is pure types plus one pure builder - no React, no Tiptap, no
 * network. The revision scheme and the canonical bridge are the existing shared
 * ones (`contentRevisionOf` and `canonicalFromEditorDocument`), so the context
 * never becomes a second revision or document system.
 */
import { contentRevisionOf, type CanonicalDocument, type TipDoc } from '@seo/contracts';
import { canonicalFromEditorDocument } from '../editorDraft';

/**
 * Normalized selection kinds. `none` means the document is active but no
 * meaningful text/node/cursor context is available; `cursor` is an insertion
 * point; `text` is a non-empty text range; `node` is a selected editor node.
 */
export type EditorSelectionKind = 'none' | 'cursor' | 'text' | 'node';

/**
 * A selection normalized for consumers. Only reliable data is captured:
 * positions come from the live ProseMirror selection, `nodePath` is a
 * structural index path and therefore **transient** (it is not a durable block
 * identity), and `blockId` is only present when the node already carries a real
 * `id` attribute. Nothing here is fabricated.
 */
export interface EditorSelectionSnapshot {
  type: EditorSelectionKind;
  /** ProseMirror document positions; present for cursor/text/node. */
  from?: number;
  to?: number;
  /** Editor node name at the selection/insertion point, when reliably known. */
  nodeType?: string;
  /** Structural index path from the document root. Transient, not an identity. */
  nodePath?: number[];
  /** Only set from a node's existing `id` attribute; never invented. */
  blockId?: string;
}

/** The selection snapshot used before any editor selection is available. */
export const EMPTY_EDITOR_SELECTION: EditorSelectionSnapshot = { type: 'none' };

/**
 * The local document as the editor sees it. `canonical` is null when the
 * document cannot be represented canonically (the context does not guess), and
 * `revision` is null while the context is not ready. `revision` matches the
 * value the server derives from the persisted `content_json`, so it is the same
 * concurrency token the Designer apply guard uses.
 */
export interface EditorDocumentSnapshot {
  canonical: CanonicalDocument | null;
  /** True when the local document cannot be represented canonically. */
  unrepresentable: boolean;
  /** Stable revision of the local document; null while not ready. */
  revision: string | null;
  /** True when local edits differ from the last persisted baseline. */
  dirty: boolean;
}

/**
 * The full context. `contentId` is null for a brand-new document that has not
 * been persisted yet, and `ready` is false while the workspace is still loading
 * or seeding a document - consumers must not act on a snapshot that is not
 * ready, because identity and document would not belong together yet.
 */
export interface EditorContextSnapshot {
  projectId: string;
  contentId: string | null;
  ready: boolean;
  document: EditorDocumentSnapshot;
  selection: EditorSelectionSnapshot;
}

/**
 * A future external result to apply to the editor. `expectedRevision` is the
 * revision the caller generated against; applying it only succeeds while the
 * editor still holds that revision. `source` is descriptive only.
 */
export interface ExternalEditorDocumentInput {
  canonical: CanonicalDocument;
  expectedRevision: string;
  source?: string;
}

export type ExternalEditorDocumentResult =
  | { ok: true }
  | { ok: false; reason: 'no-editor' | 'not-ready' | 'stale-revision' | 'unrepresentable' | 'apply-failed' };

export interface BuildEditorContextInput {
  projectId: string;
  contentId: string | null;
  ready: boolean;
  doc: TipDoc;
  dirty: boolean;
  selection: EditorSelectionSnapshot;
}

/**
 * Builds the normalized snapshot from the already-available editor state. Pure:
 * it does not read the editor or the DOM. When the context is not ready it
 * reports an inert snapshot rather than pairing a stale document with a new
 * identity.
 */
export function buildEditorContextSnapshot(input: BuildEditorContextInput): EditorContextSnapshot {
  if (!input.ready) {
    return {
      projectId: input.projectId,
      contentId: input.contentId,
      ready: false,
      document: { canonical: null, unrepresentable: false, revision: null, dirty: false },
      selection: EMPTY_EDITOR_SELECTION,
    };
  }

  let canonical: CanonicalDocument | null = null;
  let unrepresentable = false;
  try {
    canonical = canonicalFromEditorDocument(input.doc);
  } catch {
    unrepresentable = true;
  }

  return {
    projectId: input.projectId,
    contentId: input.contentId,
    ready: true,
    document: {
      canonical,
      unrepresentable,
      revision: contentRevisionOf(input.doc),
      dirty: input.dirty,
    },
    selection: input.selection,
  };
}
