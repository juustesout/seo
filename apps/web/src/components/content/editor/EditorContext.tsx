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
  canonicalDocumentToEditorDocument,
  contentRevisionOf,
  isValidCanonicalDoc,
  type TipDoc,
} from '@seo/contracts';
import {
  buildEditorContextSnapshot,
  EMPTY_EDITOR_SELECTION,
  type EditorContextSnapshot,
  type EditorSelectionSnapshot,
  type ExternalEditorDocumentInput,
  type ExternalEditorDocumentResult,
} from './editorContext';
import { readSelectionSnapshot } from './selection';

export interface EditorContextValue {
  /** The current normalized snapshot; always defined inside the provider. */
  snapshot: EditorContextSnapshot;
  /**
   * Applies a future external document result to the live editor. Rejects a
   * stale revision and documents that cannot be represented in the editor.
   */
  applyExternalDocument: (input: ExternalEditorDocumentInput) => ExternalEditorDocumentResult;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export interface EditorContextProviderProps {
  projectId: string;
  /** Null for a brand-new document that has not been persisted yet. */
  contentId: string | null;
  /** False while the document is still loading/seeding. */
  ready: boolean;
  /** The current local editor document as lifted by the editor boundary. */
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
    () => buildEditorContextSnapshot({ projectId, contentId, ready, doc, dirty, selection }),
    [projectId, contentId, ready, doc, dirty, selection],
  );

  const applyExternalDocument = useCallback(
    (input: ExternalEditorDocumentInput): ExternalEditorDocumentResult => {
      if (!ready) return { ok: false, reason: 'not-ready' };
      if (!editor || editor.isDestroyed) return { ok: false, reason: 'no-editor' };
      if (input.expectedRevision !== contentRevisionOf(doc)) return { ok: false, reason: 'stale-revision' };
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

  const value = useMemo<EditorContextValue>(
    () => ({ snapshot, applyExternalDocument }),
    [snapshot, applyExternalDocument],
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
