import { useCallback, useRef, useState } from 'react';

/**
 * One authoritative identity for the document a workspace currently operates on.
 * A brand-new, not-yet-persisted document is represented by `creating` with a
 * null id; leaving the workspace to the content list is neither.
 */
export interface DocumentIdentity {
  documentId: string | null;
  creating: boolean;
}

/**
 * Result of a barrier-guarded document switch. `blocked` means the current
 * document stays authoritative: either its pending save failed (still dirty and
 * retryable) or another switch is already running.
 */
export type SwitchResult =
  | { status: 'switched' }
  | { status: 'blocked'; reason: 'save_failed' }
  | { status: 'blocked'; reason: 'save_in_progress' };

interface UseDocumentSessionOptions {
  /**
   * Flush any pending/queued saves for the current document, resolving `true`
   * when it is safe to leave (clean or persisted) and `false` when a save
   * failed and the document is still dirty. Read through a ref so the session
   * always calls the latest autosave.
   */
  flush: () => Promise<boolean>;
}

const INITIAL: DocumentIdentity = { documentId: null, creating: false };

/**
 * The shared session boundary for document identity. Every identity change that
 * leaves a document - switching, starting a new one, or returning to the list -
 * must cross the save barrier so unsaved changes are flushed before the previous
 * document is abandoned. The current identity only advances once the barrier
 * resolves, so a failed save keeps the current document authoritative.
 */
export function useDocumentSession({ flush }: UseDocumentSessionOptions) {
  const [identity, setIdentity] = useState<DocumentIdentity>(INITIAL);

  const flushRef = useRef(flush);
  flushRef.current = flush;
  const switchingRef = useRef(false);

  const runBarrier = useCallback(async (next: DocumentIdentity): Promise<SwitchResult> => {
    if (switchingRef.current) return { status: 'blocked', reason: 'save_in_progress' };
    switchingRef.current = true;
    try {
      const saved = await flushRef.current();
      if (!saved) return { status: 'blocked', reason: 'save_failed' };
      setIdentity(next);
      return { status: 'switched' };
    } catch {
      // A thrown flush is still an unsaved document: keep the current one.
      return { status: 'blocked', reason: 'save_failed' };
    } finally {
      switchingRef.current = false;
    }
  }, []);

  /** Switch to an existing document (id is authoritative). */
  const requestDocumentSwitch = useCallback(
    (nextDocumentId: string): Promise<SwitchResult> =>
      runBarrier({ documentId: nextDocumentId, creating: false }),
    [runBarrier],
  );

  /** Start a new, not-yet-persisted document. */
  const requestNewDocument = useCallback((): Promise<SwitchResult> => runBarrier({ documentId: null, creating: true }), [runBarrier]);

  /** Return to the content list, leaving the current document. */
  const requestCloseDocument = useCallback((): Promise<SwitchResult> => runBarrier(INITIAL), [runBarrier]);

  /** Adopt the server id of the document just created, without a switch. */
  const adoptDocumentId = useCallback((documentId: string) => setIdentity({ documentId, creating: false }), []);

  /** Forget the current document after it was deleted; there is nothing to save. */
  const discardDocument = useCallback(() => setIdentity(INITIAL), []);

  return { identity, requestDocumentSwitch, requestNewDocument, requestCloseDocument, adoptDocumentId, discardDocument };
}

export type DocumentSession = ReturnType<typeof useDocumentSession>;
