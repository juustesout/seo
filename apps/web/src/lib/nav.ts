/**
 * Navigate within a project to another view, optionally carrying URL filters
 * (e.g. `/p/<id>/publications?content_id=…`).
 *
 * The app uses plain history-based routing instead of a router library: routes
 * are real URLs (`/p/:projectId/:view`), so deep links and back/forward work
 * for free. App listens to `popstate`, so this helper pushes the new history
 * entry and then dispatches a synthetic `popstate` to make App re-parse the
 * route - exactly as if the user had pressed back/forward.
 *
 * R5.9: like the App's own navigation helpers, this crosses the workspace save
 * barrier first, so leaving an open document for a project view (publications,
 * calendar, …) flushes pending edits and is refused when the save failed.
 */
import { runNavigationBarrier } from './navigationBarrier';

export async function openProjectView(
  projectId: string,
  view: string,
  params?: Record<string, string | null>,
): Promise<boolean> {
  if (!(await runNavigationBarrier())) return false;
  const search = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
  }
  const qs = search.toString();
  const path = `/p/${projectId}/${view}${qs ? `?${qs}` : ''}`;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  return true;
}
