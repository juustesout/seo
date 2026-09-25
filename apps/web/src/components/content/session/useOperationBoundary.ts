import { useCallback, useRef } from 'react';

/**
 * A capture of the active document boundary for one async operation. `isStale`
 * becomes true as soon as the session boundary has moved past the capture.
 */
export interface OperationBoundary {
  isStale: () => boolean;
}

/**
 * Guards an async per-document operation (inline AI today, the unified
 * assistant later) against a late result being applied to the wrong document.
 *
 * The caller passes the live session `boundary` - the same frozen key that
 * scopes editor history and document-scoped workspace state. `begin()` captures
 * the current value and returns an `isStale` probe that compares against the
 * latest value, so a document switch, a new document or a close invalidates the
 * operation, while an id adoption (which preserves the boundary) does not.
 *
 * This intentionally wraps the existing session boundary instead of adding a
 * second identity or a global epoch. It only drops results; it does not change
 * how the operation runs, what it sends or how a current result is applied.
 */
export function useOperationBoundary(boundary: string): () => OperationBoundary {
  const ref = useRef(boundary);
  ref.current = boundary;

  return useCallback(() => {
    const started = ref.current;
    return { isStale: () => ref.current !== started };
  }, []);
}
