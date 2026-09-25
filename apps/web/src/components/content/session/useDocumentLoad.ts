import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentLifecycleStatus, DocumentLoadState } from './useDocumentSession';

/**
 * State of loading the active document. It extends the raw load state that
 * feeds `documentLifecycle` with the loaded payload and a retry. The state is
 * stamped with the requested id, so a response for a document that is no longer
 * active can never surface under the active one.
 */
export interface DocumentLoad<T> extends DocumentLoadState {
  data: T | null;
  /** Re-run the load for the active document. No-op while idle. */
  reload: () => void;
  /**
   * Mark `documentId` as already loaded without fetching, so adopting the first
   * persisted id of a new document does not enter the loading lifecycle and
   * remount the editor (R5.2.9). The live editor stays authoritative; a later
   * genuine switch to this id loads normally, and `reload` still forces a fetch.
   */
  adopt: (documentId: string, data?: T | null) => void;
}

interface LoadedState<T> {
  documentId: string | null;
  status: DocumentLifecycleStatus;
  data: T | null;
  error: string | null;
}

/**
 * Identity-keyed document loader.
 *
 * Unlike a plain fetch hook, the result is only ever exposed for the id it was
 * requested for: changing `documentId` immediately reports `loading` and clears
 * the previous payload/error, and a late response from the outgoing document is
 * dropped by a per-run `alive` guard. That is what lets the canonical lifecycle
 * treat the loader as a trustworthy source without its own epoch.
 */
export function useDocumentLoad<T>(
  documentId: string | null,
  load: (documentId: string) => Promise<T>,
): DocumentLoad<T> {
  const [state, setState] = useState<LoadedState<T>>({ documentId: null, status: 'idle', data: null, error: null });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  // The id already loaded without a fetch via `adopt`; a document change to it
  // is then skipped until an explicit reload clears this.
  const adoptedRef = useRef<string | null>(null);

  useEffect(() => {
    // The adoption marker only suppresses the load for the id it was created
    // for. Once the active id moves elsewhere (including leaving the document),
    // the marker is cleared so a later genuine switch back to that id loads
    // normally instead of showing the adopted-but-empty state.
    if (adoptedRef.current !== null && adoptedRef.current !== documentId) adoptedRef.current = null;
    if (!documentId) return;
    if (adoptedRef.current === documentId) return;
    let alive = true;
    setState({ documentId, status: 'loading', data: null, error: null });
    loadRef.current(documentId).then(
      (data) => {
        if (alive) setState({ documentId, status: 'ready', data, error: null });
      },
      (e: unknown) => {
        if (alive) setState({ documentId, status: 'error', data: null, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [documentId, tick]);

  const reload = useCallback(() => {
    adoptedRef.current = null;
    setTick((value) => value + 1);
  }, []);

  const adopt = useCallback((documentId: string, data: T | null = null) => {
    adoptedRef.current = documentId;
    setState({ documentId, status: 'ready', data, error: null });
  }, []);

  // A state that describes a different id than the one requested is stale by
  // definition; report it as loading (or idle when nothing is requested) so no
  // caller can read the previous document's payload as the active one.
  if (documentId === null) {
    return { documentId: null, status: 'idle', data: null, error: null, reload, adopt };
  }
  if (state.documentId !== documentId) {
    return { documentId, status: 'loading', data: null, error: null, reload, adopt };
  }
  return { ...state, reload, adopt };
}
