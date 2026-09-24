import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';

const STANDALONE_SCOPE = 'standalone';
const WorkspaceStateContext = createContext<string | null>(null);

/**
 * Carries the active document boundary key for workspace UI state. The key is
 * the session's `documentScopeKey` (identity + generation), so it moves exactly
 * on a successful document transition and stays put on a blocked one. This
 * provider owns only UI state scoping; the document identity itself stays with
 * `DocumentSession`.
 */
export function WorkspaceStateProvider({ documentKey, children }: { documentKey: string; children: ReactNode }) {
  return <WorkspaceStateContext.Provider value={documentKey}>{children}</WorkspaceStateContext.Provider>;
}

/** The active document boundary key, or a constant when rendered outside a provider. */
export function useWorkspaceScope(): string {
  return useContext(WorkspaceStateContext) ?? STANDALONE_SCOPE;
}

/**
 * Transient workspace UI state that is scoped to the active document.
 *
 * The value is stored together with the scope key it belongs to. When the scope
 * moves on (a successful document switch, new document or close) the stored
 * entry no longer matches and reads return `initial`; a setter captured under
 * the previous scope can only write under that stale scope, so it can never be
 * read back. No effect and no remount are involved, and a plain rerender or a
 * failed switch leaves the boundary key unchanged and therefore the value
 * intact.
 */
export function useDocumentScopedState<T>(initial: T): [T, Dispatch<SetStateAction<T>>] {
  const scope = useWorkspaceScope();
  const [entry, setEntry] = useState<{ scope: string; value: T }>(() => ({ scope, value: initial }));

  const value = entry.scope === scope ? entry.value : initial;

  const setValue: Dispatch<SetStateAction<T>> = (next) => {
    setEntry((current) => {
      const base = current.scope === scope ? current.value : initial;
      const value = typeof next === 'function' ? (next as (prev: T) => T)(base) : next;
      return { scope, value };
    });
  };

  return [value, setValue];
}
