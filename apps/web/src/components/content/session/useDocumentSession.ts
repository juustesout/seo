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

/** The one lifecycle vocabulary for the active document. */
export type DocumentLifecycleStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Raw document-loader state. It is stamped with the id it describes, so a
 * response that arrives after the identity moved on is distinguishable from
 * one for the active document. It carries no readiness rule of its own - that
 * belongs to `documentLifecycle`.
 */
export interface DocumentLoadState {
  /** The document id this loader state describes; null when nothing is requested. */
  documentId: string | null;
  status: DocumentLifecycleStatus;
  error?: string | null;
}

/** The canonical lifecycle of the active document, derived from the session. */
export interface DocumentLifecycle {
  status: DocumentLifecycleStatus;
  /** The active document id this lifecycle describes; null when idle. */
  documentId: string | null;
  /** The load failure, when status is `error`. */
  error: string | null;
}

export const IDLE_DOCUMENT_LOAD: DocumentLoadState = { documentId: null, status: 'idle', error: null };

const LOAD_ERROR_FALLBACK = 'Could not load this document.';

/**
 * The one canonical document lifecycle projection: a pure function of the
 * authoritative session identity and the raw loader state. It is the single
 * place that decides whether the active document is loading, ready or failed,
 * so no consumer keeps a second readiness boolean.
 *
 * A brand-new document is ready without a fetch. For a persisted document the
 * loader state is trusted only when it describes the active identity, so a
 * late or mismatched response for the previous document can never make the
 * active document ready or errored; until the loader aligns with the identity
 * the lifecycle stays `loading`.
 */
export function documentLifecycle(
  identity: DocumentIdentity,
  load: DocumentLoadState = IDLE_DOCUMENT_LOAD,
): DocumentLifecycle {
  if (identity.creating) return { status: 'ready', documentId: null, error: null };
  if (identity.documentId === null) return { status: 'idle', documentId: null, error: null };
  if (load.documentId !== identity.documentId) {
    return { status: 'loading', documentId: identity.documentId, error: null };
  }
  if (load.status === 'error') {
    return { status: 'error', documentId: identity.documentId, error: load.error ?? LOAD_ERROR_FALLBACK };
  }
  if (load.status === 'ready') return { status: 'ready', documentId: identity.documentId, error: null };
  return { status: 'loading', documentId: identity.documentId, error: null };
}

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
 * The lifetime key of the editor instance, and therefore of its undo/redo
 * history. The editor component is keyed by this value, so a new key remounts
 * the editor and starts a fresh ProseMirror history.
 *
 * It is derived from the canonical session identity plus the session
 * generation, so it changes on every successful document change and stays
 * constant across a failed one. History therefore never crosses a document
 * boundary, while a failed switch keeps the current editor and its history.
 * It deliberately does not add a second identity owner: it is a pure projection
 * of the identity the session already owns.
 */
export function editorHistoryKey(identity: DocumentIdentity, generation: number): string {
  const id = identity.creating ? 'new' : identity.documentId ?? 'closed';
  return `${id}#${generation}`;
}

/**
 * The shared session boundary for document identity. Every identity change that
 * leaves a document - switching, starting a new one, or returning to the list -
 * must cross the save barrier so unsaved changes are flushed before the previous
 * document is abandoned. The current identity only advances once the barrier
 * resolves, so a failed save keeps the current document authoritative.
 *
 * The session also owns the `generation`: it advances only when the barrier
 * allows a document change. Consumers key the editor by
 * `editorHistoryKey(identity, generation)` so the editor instance - and its
 * undo/redo history - is replaced exactly on a successful change and preserved
 * on a failed one.
 */
export function useDocumentSession({ flush }: UseDocumentSessionOptions) {
  const [identity, setIdentity] = useState<DocumentIdentity>(INITIAL);
  const [generation, setGeneration] = useState(0);

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
      // Advance the session generation only after the barrier held, so the
      // editor instance (and its history boundary) advances with the identity.
      setGeneration((value) => value + 1);
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

  /** True while a document is active, whether persisted or brand new. */
  const hasDocument = identity.creating || identity.documentId !== null;

  return {
    identity,
    generation,
    hasDocument,
    requestDocumentSwitch,
    requestNewDocument,
    requestCloseDocument,
    adoptDocumentId,
    discardDocument,
  };
}

export type DocumentSession = ReturnType<typeof useDocumentSession>;
