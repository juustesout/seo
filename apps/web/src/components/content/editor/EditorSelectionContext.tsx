/**
 * Canonical selection boundary (R5.2.4).
 *
 * This is the single owner of the editor selection. It subscribes to the live
 * Tiptap instance once and publishes one normalized, document-scoped snapshot.
 * Every other consumer derives from it:
 * - the composition surface reads the coarse `element` projection;
 * - `EditorContext` copies the snapshot into its context (no own state);
 * - the AI toolbar's `hasSelection` is computed from `snapshotHasSelection`.
 *
 * The selection belongs to the document it was made in: when the document
 * identity changes the snapshot is cleared, so a selection from document A is
 * never read as belonging to document B.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import type { EditorSelection } from './types';
import { EMPTY_EDITOR_SELECTION, type EditorSelectionSnapshot } from './editorContext';
import { editorSelectionFromSnapshot, readSelectionSnapshot } from './selection';

export interface EditorSelectionContextValue {
  /** The canonical, normalized, document-scoped selection. */
  selection: EditorSelectionSnapshot;
  /** Coarse element projection of `selection`, derived for the composition surface. */
  element: EditorSelection;
  /**
   * Bumped when a feature wants the settings rail to reveal the current
   * selection. It carries no selection itself: the live selection already lives
   * here, so consumers only need to react to the request.
   */
  revealRequest: number;
  requestReveal: () => void;
}

const EditorSelectionContext = createContext<EditorSelectionContextValue | null>(null);

export function EditorSelectionProvider({
  editor = null,
  documentId = null,
  children,
}: {
  /** The live Tiptap instance that owns the real selection. */
  editor?: Editor | null;
  /** Identity of the document the editor holds; a change clears the selection. */
  documentId?: string | null;
  children: ReactNode;
}) {
  const [selection, setSelection] = useState<EditorSelectionSnapshot>(EMPTY_EDITOR_SELECTION);
  const [revealRequest, setRevealRequest] = useState(0);

  // Read through a ref so the subscription can detect a document change without
  // re-subscribing (and without re-reading the old document's selection).
  const documentIdRef = useRef(documentId);
  documentIdRef.current = documentId;

  useEffect(() => {
    setSelection(EMPTY_EDITOR_SELECTION);
  }, [documentId]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      setSelection(EMPTY_EDITOR_SELECTION);
      return;
    }
    const owner = documentIdRef.current;
    const sync = () => {
      if (documentIdRef.current !== owner) return;
      setSelection(readSelectionSnapshot(editor));
    };
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

  const requestReveal = useCallback(() => setRevealRequest((value) => value + 1), []);
  const element = useMemo(() => editorSelectionFromSnapshot(selection), [selection]);
  const value = useMemo(
    () => ({ selection, element, revealRequest, requestReveal }),
    [selection, element, revealRequest, requestReveal],
  );
  return <EditorSelectionContext.Provider value={value}>{children}</EditorSelectionContext.Provider>;
}

/** The shared selection, or null when rendered outside the workspace provider. */
export function useEditorSelection(): EditorSelectionContextValue | null {
  return useContext(EditorSelectionContext);
}
