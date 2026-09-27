/**
 * Programmatic navigation barrier (R5.9).
 *
 * The unified workspace owns the canonical document session and its save
 * barrier (R5.6). Route navigation, however, used to bypass it: the project
 * switcher and the project nav push a new URL, which unmounts the workspace and
 * would abandon a debounced edit. The workspace registers one barrier while it
 * is mounted and the app's navigation helpers await it before pushing, so leaving
 * the workspace crosses the same autosave `flush` a document switch already uses.
 *
 * A barrier may refuse (resolve `false`) when the document could not be saved;
 * the caller then leaves the route untouched and the workspace stays mounted and
 * authoritative. This is deliberately not a second unsaved-change mechanism: it
 * exposes the existing autosave to navigation and owns no document state.
 *
 * There is at most one workspace mounted, so the registry holds a single barrier.
 */
export type NavigationBarrier = () => Promise<boolean>;

let barrier: NavigationBarrier | null = null;

/** Register the active barrier, or clear it with `null` on unmount. */
export function registerNavigationBarrier(next: NavigationBarrier | null): void {
  barrier = next;
}

/**
 * Await the active barrier. Defaults to allowing navigation when no barrier is
 * registered (every non-workspace screen) and refuses when the barrier itself
 * throws, so a navigation can never proceed past an unresolved save.
 */
export async function runNavigationBarrier(): Promise<boolean> {
  if (!barrier) return true;
  try {
    return await barrier();
  } catch {
    return false;
  }
}
