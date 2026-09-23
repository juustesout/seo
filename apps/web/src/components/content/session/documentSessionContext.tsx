import { createContext, useContext, type ReactNode } from 'react';
import type { AutosaveStatus } from '../useAutosave';
import type { DocumentLifecycle, SwitchResult } from './useDocumentSession';

/**
 * The canonical shared session context for the current editing experience.
 *
 * It is the single consumer contract around the authoritative document
 * identity: the editor, the content surface and the save lifecycle all read the
 * active document from here instead of prop-drilling their own copies.
 * `documentId` is null for a brand-new, not-yet-persisted document (`isNew`) and
 * for no document at all (`hasDocument` false). `lifecycle` is the one document
 * lifecycle (idle/loading/ready/error); `dirty`/`saveState` surface the state
 * the autosave already owns. None of them is a second source of truth.
 */
export interface DocumentSessionValue {
  projectId: string;
  /** The active document id, or null when nothing is persisted yet. */
  documentId: string | null;
  /** True when a brand-new, not-yet-persisted document is active. */
  isNew: boolean;
  /** True when any document (persisted or new) is active. */
  hasDocument: boolean;
  /** The single lifecycle of the active document. */
  lifecycle: DocumentLifecycle;
  /** True when local edits differ from the persisted baseline. */
  dirty: boolean;
  /** The autosave status for the active document. */
  saveState: AutosaveStatus;
  /** Request a switch to another document; only advances after the save barrier. */
  requestDocumentSwitch: (nextDocumentId: string) => Promise<SwitchResult>;
  /** Request a new, not-yet-persisted document. */
  requestNewDocument: () => Promise<SwitchResult>;
  /** Request closing the current document back to the content list. */
  requestCloseDocument: () => Promise<SwitchResult>;
  /** Adopt a server id for the just-created document (no barrier). */
  adoptDocumentId: (documentId: string) => void;
  /** Forget a document that was deleted (no barrier). */
  discardDocument: () => void;
}

const DocumentSessionContext = createContext<DocumentSessionValue | null>(null);

/**
 * Distributes the one session authority to consumers. The value is owned by the
 * content experience (which also owns the loader and autosave); this provider
 * only makes it readable, it does not create a second identity.
 */
export function DocumentSessionProvider({ value, children }: { value: DocumentSessionValue; children: ReactNode }) {
  return <DocumentSessionContext.Provider value={value}>{children}</DocumentSessionContext.Provider>;
}

/** The session context, or null when rendered outside the content experience. */
export function useDocumentSessionContext(): DocumentSessionValue | null {
  return useContext(DocumentSessionContext);
}

/** The session context, required. Throws when a consumer is mis-nested. */
export function useRequiredDocumentSession(): DocumentSessionValue {
  const value = useContext(DocumentSessionContext);
  if (!value) throw new Error('useRequiredDocumentSession must be used within a DocumentSessionProvider');
  return value;
}
