import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { EditorSelection } from './types';

export interface EditorSelectionContextValue {
  selection: EditorSelection;
  setSelection: (selection: EditorSelection) => void;
  /**
   * Bumped when a feature wants the settings rail to reveal the current
   * selection. It carries no selection itself: the live selection is already
   * lifted here, so consumers only need to react to the request.
   */
  revealRequest: number;
  requestReveal: () => void;
}

const EditorSelectionContext = createContext<EditorSelectionContextValue | null>(null);

/**
 * Lifts the active-block/element selection out of the composition surface so
 * the contextual toolbar and the workspace can read the same selection. R1
 * uses this for context and temporary selection only: the selection is keyed by
 * a document `path`, which is not a durable identity (see the R1.1 recon D5
 * note).
 */
export function EditorSelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<EditorSelection>(null);
  const [revealRequest, setRevealRequest] = useState(0);
  const requestReveal = useCallback(() => setRevealRequest((value) => value + 1), []);
  const value = useMemo(
    () => ({ selection, setSelection, revealRequest, requestReveal }),
    [selection, revealRequest, requestReveal],
  );
  return <EditorSelectionContext.Provider value={value}>{children}</EditorSelectionContext.Provider>;
}

/** The shared selection, or null when rendered outside the workspace provider. */
export function useEditorSelection(): EditorSelectionContextValue | null {
  return useContext(EditorSelectionContext);
}
