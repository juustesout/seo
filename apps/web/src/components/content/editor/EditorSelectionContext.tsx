import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { EditorSelection } from './types';

export interface EditorSelectionContextValue {
  selection: EditorSelection;
  setSelection: (selection: EditorSelection) => void;
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
  const value = useMemo(() => ({ selection, setSelection }), [selection]);
  return <EditorSelectionContext.Provider value={value}>{children}</EditorSelectionContext.Provider>;
}

/** The shared selection, or null when rendered outside the workspace provider. */
export function useEditorSelection(): EditorSelectionContextValue | null {
  return useContext(EditorSelectionContext);
}
