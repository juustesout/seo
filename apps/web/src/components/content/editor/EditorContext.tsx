/**
 * Editor context provider (R1.2).
 *
 * Owns the live, normalized view of the editor: identity, local document,
 * revision, dirty state and a document-scoped selection snapshot. It subscribes
 * to the Tiptap instance once (selection/focus/blur) so no future feature has
 * to. It also exposes the single controlled seam for applying an external
 * document result (`applyExternalDocument`), which validates the revision,
 * writes through a normal editor transaction and therefore reuses the existing
 * `onDocChange` + autosave path instead of adding a second persistence system.
 *
 * The element selection used by the composition sidebar stays in
 * `EditorSelectionContext`; that is a coarse element projection, while this
 * provider exposes the normalized selection for Editor-native features.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import {
  applyDocumentOperations as executeDocumentOperations,
  canonicalDocumentToEditorDocument,
  isValidCanonicalDoc,
  type CanonicalDocument,
  type DocumentOperationBatch,
  type ImageInsertionContext,
  type InsertImageOperation,
  type TipDoc,
} from '@seo/contracts';
import { canonicalFromEditorDocument } from '../editorDraft';
import { documentRevisionOf } from '../documentRevision';
import {
  buildEditorContextSnapshot,
  EMPTY_EDITOR_SELECTION,
  type DocumentOperationApplyResult,
  type EditorContextSnapshot,
  type EditorSelectionSnapshot,
  type ExternalEditorDocumentInput,
  type ExternalEditorDocumentResult,
} from './editorContext';
import {
  applyImageInsertionOperation,
  imageInsertionContextFromSnapshot,
  readEditorImageSemantics,
  selectInsertedImage,
  type ImageInsertionApplyResult,
} from './imageInsertion';
import { readSelectionSnapshot } from './selection';

export interface EditorContextValue {
  /** The current normalized snapshot; always defined inside the provider. */
  snapshot: EditorContextSnapshot;
  /**
   * Applies a future external document result to the live editor. Rejects a
   * stale revision and documents that cannot be represented in the editor.
   */
  applyExternalDocument: (input: ExternalEditorDocumentInput) => ExternalEditorDocumentResult;
  /**
   * Builds the bounded R3.1 image-insertion context from the live editor, or
   * null when the document is not ready/persisted/clean or has no reliable
   * target. Backend-facing: never contains a Tiptap object.
   */
  buildImageInsertionContext: () => ImageInsertionContext | null;
  /**
   * Applies a returned `insert_image` operation as one undoable editor
   * transaction, guarded by the revision the request was generated against.
   */
  applyImageInsertion: (operation: InsertImageOperation, expectedRevision: string) => ImageInsertionApplyResult;
  /**
   * Applies a document operation batch as one undoable editor transaction,
   * guarded by the revision the batch was generated against. The whole batch is
   * applied through a single document replacement, so it takes one autosave and
   * one undo, and a returned image (if any) is selected for its properties.
   */
  applyDocumentOperations: (batch: DocumentOperationBatch, expectedRevision: string) => DocumentOperationApplyResult;
}

const EditorContext = createContext<EditorContextValue | null>(null);

/**
 * Reads the document straight off the live Tiptap instance. The `doc` prop is
 * only a render trigger (it lands one render behind the editor), so the
 * snapshot and every revision guard must treat the live editor as the source of
 * truth and use the prop solely as a fallback when no editor exists yet.
 */
function liveDocumentOf(editor: Editor | null, fallback: TipDoc): TipDoc {
  if (!editor || editor.isDestroyed) return fallback;
  try {
    return editor.getJSON() as unknown as TipDoc;
  } catch {
    return fallback;
  }
}

export interface EditorContextProviderProps {
  projectId: string;
  /** Null for a brand-new document that has not been persisted yet. */
  contentId: string | null;
  /** False while the document is still loading/seeding. */
  ready: boolean;
  /**
   * The lifted editor document. It is only a render trigger/fallback: revision
   * and guards read the live editor, never this one-render-behind value.
   */
  doc: TipDoc;
  /** True when local edits differ from the persisted baseline. */
  dirty: boolean;
  editor: Editor | null;
  children: ReactNode;
}

export function EditorContextProvider({
  projectId,
  contentId,
  ready,
  doc,
  dirty,
  editor,
  children,
}: EditorContextProviderProps) {
  const [selection, setSelection] = useState<EditorSelectionSnapshot>(EMPTY_EDITOR_SELECTION);

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      setSelection(EMPTY_EDITOR_SELECTION);
      return;
    }
    const sync = () => setSelection(readSelectionSnapshot(editor));
    sync();
    editor.on('selectionUpdate', sync);
    editor.on('focus', sync);
    editor.on('blur', sync);
    return () => {
      editor.off('selectionUpdate', sync);
      editor.off('focus', sync);
      editor.off('blur', sync);
    };
  }, [editor]);

  const snapshot = useMemo(
    () => buildEditorContextSnapshot({ projectId, contentId, ready, doc: liveDocumentOf(editor, doc), dirty, selection }),
    [projectId, contentId, ready, doc, dirty, selection, editor],
  );

  const applyExternalDocument = useCallback(
    (input: ExternalEditorDocumentInput): ExternalEditorDocumentResult => {
      if (!ready) return { ok: false, reason: 'not-ready' };
      if (!editor || editor.isDestroyed) return { ok: false, reason: 'no-editor' };
      if (input.expectedRevision !== documentRevisionOf(liveDocumentOf(editor, doc))) {
        return { ok: false, reason: 'stale-revision' };
      }
      if (!isValidCanonicalDoc(input.canonical)) return { ok: false, reason: 'unrepresentable' };
      try {
        const next = canonicalDocumentToEditorDocument(input.canonical);
        // A normal transaction: it is undoable and emits an update, so the
        // existing onDocChange + autosave boundary persists it. Selection is
        // deliberately reset by the replacement rather than guessed at.
        return editor.commands.setContent(next, true) ? { ok: true } : { ok: false, reason: 'apply-failed' };
      } catch {
        return { ok: false, reason: 'apply-failed' };
      }
    },
    [ready, editor, doc],
  );

  const buildImageInsertionContext = useCallback((): ImageInsertionContext | null => {
    const semantics = readEditorImageSemantics(editor);
    return imageInsertionContextFromSnapshot(snapshot, semantics);
  }, [editor, snapshot]);

  const applyImageInsertion = useCallback(
    (operation: InsertImageOperation, expectedRevision: string): ImageInsertionApplyResult => {
      if (!ready) return { ok: false, reason: 'not-ready' };
      if (!editor || editor.isDestroyed) return { ok: false, reason: 'no-editor' };
      if (documentRevisionOf(liveDocumentOf(editor, doc)) !== expectedRevision) return { ok: false, reason: 'stale-revision' };
      return applyImageInsertionOperation(editor, operation);
    },
    [ready, editor, doc],
  );

  const applyDocumentOperations = useCallback(
    (batch: DocumentOperationBatch, expectedRevision: string): DocumentOperationApplyResult => {
      if (!ready) return { ok: false, reason: 'not-ready' };
      if (!editor || editor.isDestroyed) return { ok: false, reason: 'no-editor' };
      const current = liveDocumentOf(editor, doc);
      if (documentRevisionOf(current) !== expectedRevision || batch.baseRevision !== expectedRevision) {
        return { ok: false, reason: 'stale-revision' };
      }
      let base: CanonicalDocument;
      try {
        base = canonicalFromEditorDocument(current);
      } catch {
        return { ok: false, reason: 'unrepresentable' };
      }
      let next: CanonicalDocument;
      try {
        next = executeDocumentOperations(base, batch);
      } catch {
        return { ok: false, reason: 'apply-failed' };
      }
      try {
        // One replacement transaction: undoable, emits a single update and
        // therefore reuses the existing onDocChange + autosave boundary.
        if (!editor.commands.setContent(canonicalDocumentToEditorDocument(next), true)) {
          return { ok: false, reason: 'apply-failed' };
        }
      } catch {
        return { ok: false, reason: 'apply-failed' };
      }
      const imageOperation = [...batch.operations].reverse().find((operation) => operation.type === 'insert_image');
      if (imageOperation?.type === 'insert_image' && imageOperation.image.assetId) {
        try {
          selectInsertedImage(editor, imageOperation.image.assetId);
        } catch {
          // Selection is a presentation nicety; the batch itself succeeded.
        }
      }
      return { ok: true };
    },
    [ready, editor, doc],
  );

  const value = useMemo<EditorContextValue>(
    () => ({ snapshot, applyExternalDocument, buildImageInsertionContext, applyImageInsertion, applyDocumentOperations }),
    [snapshot, applyExternalDocument, buildImageInsertionContext, applyImageInsertion, applyDocumentOperations],
  );

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

/** The full editor context, or null when rendered outside the provider. */
export function useEditorContext(): EditorContextValue | null {
  return useContext(EditorContext);
}

/** Convenience read of just the snapshot. */
export function useEditorContextSnapshot(): EditorContextSnapshot | null {
  return useContext(EditorContext)?.snapshot ?? null;
}
