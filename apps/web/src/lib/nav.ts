/**
 * Navigate within a project to another view, optionally carrying URL filters
 * (e.g. /p/<id>/publications?content_id=…). App listens to popstate, so we
 * push the history entry and dispatch popstate to trigger the route update.
 */
export function openProjectView(projectId: string, view: string, params?: Record<string, string | null>): void {
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
}
