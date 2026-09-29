/**
 * Route-transition controller for the hand-rolled history router (R5.11.1).
 *
 * App routes are plain URLs and App listens to `popstate`; there is no router
 * library. R5.9 routed App's own navigation helpers through the workspace save
 * barrier (`lib/navigationBarrier.ts`), but browser Back/Forward - and any other
 * `popstate` - still changed the route directly. The URL had already moved by
 * the time the listener ran, the workspace unmounted, and a debounced edit was
 * abandoned with no refusal and no error.
 *
 * This controller is the single place that applies a route change, so both the
 * programmatic `navigate` and a browser-initiated `handlePop` cross the same
 * barrier. It owns no document state: it only awaits the registered barrier and
 * asks App to commit a route. A refused transition leaves the workspace mounted
 * and authoritative, and restores the URL it is still showing so route and
 * history never diverge.
 *
 * History is not replaced: entries are pushed exactly as before, and a refused
 * pop is undone with `replaceState` on the entry the browser already moved to.
 * `pushState` there would add a duplicate entry on every refused attempt (the
 * user could press Back forever and grow the stack); `replaceState` restores the
 * visible URL in place, with no growth and no re-entrant `popstate`.
 */
import { isSameWorkspaceSession, parseRoute, routeUrl, routesEqual, type Route } from './projectRoute';
import { runNavigationBarrier } from './navigationBarrier';

/**
 * `popstate` state flag set by a programmatic caller that has already crossed
 * the barrier itself (see `openProjectView`), so `handlePop` applies the route
 * without asking the same barrier twice. It is carried on the dispatched event
 * only - never written to `history.state` - so returning to that entry later via
 * Back/Forward is still gated normally.
 */
export const PRE_GATED_POP_STATE = '__seoPreGatedRoute';

export interface RouteNavigation {
  /** Commit a route: cross the barrier, then push and apply it. */
  navigate: (next: Route) => Promise<boolean>;
  /** Apply a browser Back/Forward pop: cross the barrier, or restore the URL. */
  handlePop: (event?: PopStateEvent) => Promise<boolean>;
}

export interface RouteNavigationOptions {
  /** The route App currently renders. */
  getRoute: () => Route;
  /** Commit a route into App state. */
  setRoute: (route: Route) => void;
  /** The workspace save barrier. Injectable for tests. */
  runBarrier?: () => Promise<boolean>;
  /** The History to read/write. Injectable for tests. */
  history?: Pick<History, 'pushState' | 'replaceState'>;
}

export function createRouteNavigation({
  getRoute,
  setRoute,
  runBarrier = runNavigationBarrier,
  history = window.history,
}: RouteNavigationOptions): RouteNavigation {
  // One programmatic transition at a time, so a double click cannot push twice.
  // The browser serializes its own Back/Forward traversals; this flag only
  // guards the in-app helpers, which is where a double push is reachable.
  let pushing = false;

  const navigate = async (next: Route): Promise<boolean> => {
    if (pushing) return false;
    const from = getRoute();
    // A same-project workspace change reuses the mounted session (the shell is
    // keyed by project id); the session's own barrier still guards any document
    // switch it triggers, so the route barrier is not needed here.
    const skipBarrier = isSameWorkspaceSession(from, next);
    pushing = true;
    try {
      if (!skipBarrier && !(await runBarrier())) return false;
      history.pushState({}, '', routeUrl(next));
      setRoute(next);
      return true;
    } finally {
      pushing = false;
    }
  };

  const handlePop = async (event?: PopStateEvent): Promise<boolean> => {
    const from = getRoute();
    const next = parseRoute();
    // A pop for the route already rendered (e.g. the entry just restored) is a
    // no-op: it can never re-run the barrier or re-restore the URL, so a refused
    // Back/Forward cannot loop.
    if (routesEqual(from, next)) return true;

    // Already crossed by the programmatic caller that pushed this entry.
    const state = event?.state as Record<string, unknown> | null | undefined;
    if (state?.[PRE_GATED_POP_STATE]) {
      setRoute(next);
      return true;
    }

    // Not a document-leaving transition: reuse the mounted workspace.
    if (isSameWorkspaceSession(from, next)) {
      setRoute(next);
      return true;
    }

    if (!(await runBarrier())) {
      // Refused: the workspace is still mounted and authoritative. Undo the
      // URL the browser already moved to, in place, so Back/Forward cannot
      // accumulate entries and route/history stay consistent.
      history.replaceState({}, '', routeUrl(from));
      return false;
    }
    setRoute(next);
    return true;
  };

  return { navigate, handlePop };
}
