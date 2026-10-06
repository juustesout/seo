/**
 * Project workspace route model (R5.3).
 *
 * Hand-rolled history routing shared by `App.tsx`. A project route is
 * `/p/:projectId/:view[/:sub[/:sub2]]`: `view` selects a project surface, and
 * up to two sub-segments let a surface own URL-based sections
 * (`/p/:id/knowledge/sources`) or the unified workspace carry a mode plus a
 * document id (`/p/:id/workspace/:mode/:contentId`).
 */
export type TopArea = 'overview' | 'projects' | 'compose' | 'integrations' | 'keys' | 'usage' | 'plan';

/** Public legal documents reachable without a session (`/privacy`, `/terms`, `/cookies`). */
export type LegalPage = 'privacy' | 'terms' | 'cookies';

export const LEGAL_PAGES: LegalPage[] = ['privacy', 'terms', 'cookies'];

export function isLegalPage(value: string): value is LegalPage {
  return (LEGAL_PAGES as string[]).includes(value);
}

export type Route =
  | { area: TopArea }
  | { area: 'project'; projectId: string; view: string; sub: string | null; sub2: string | null; search: string }
  // Platform administration is separate from project administration and carries
  // its own section (`/admin`, `/admin/users`, ...).
  | { area: 'admin'; view: string }
  // Legal documents are public: they must render for anonymous visitors (GDPR),
  // so they are a route area the auth gate never blocks.
  | { area: 'legal'; view: LegalPage };

/** Derive the current Route from the URL. */
export function parseRoute(): Route {
  const seg = window.location.pathname.split('/').filter(Boolean);
  if (seg[0] && isLegalPage(seg[0])) {
    return { area: 'legal', view: seg[0] };
  }
  if (seg[0] === 'p' && seg[1]) {
    return {
      area: 'project',
      projectId: seg[1],
      view: seg[2] || 'dashboard',
      sub: seg[3] ?? null,
      sub2: seg[4] ?? null,
      search: window.location.search,
    };
  }
  if (seg[0] === 'admin') {
    return { area: 'admin', view: seg[1] || 'overview' };
  }
  const area = seg[0] === 'projects' || seg[0] === 'compose' || seg[0] === 'integrations' || seg[0] === 'keys' || seg[0] === 'usage' || seg[0] === 'plan' ? seg[0] : 'overview';
  return { area };
}

/** Render a Route back to its canonical URL path. */
export function routePath(r: Route): string {
  if (r.area === 'project') return `/p/${r.projectId}/${r.view}${r.sub ? `/${r.sub}` : ''}${r.sub2 ? `/${r.sub2}` : ''}`;
  if (r.area === 'admin') return r.view === 'overview' ? '/admin' : `/admin/${r.view}`;
  if (r.area === 'legal') return `/${r.view}`;
  return `/${r.area === 'overview' ? 'overview' : r.area}`;
}

/**
 * Render a Route to the exact URL it was parsed from, path plus query. Used
 * when a refused navigation has to put the browser URL back to the route the UI
 * is still showing (R5.11.1), so the filter query a project surface carries is
 * not dropped.
 */
export function routeUrl(r: Route): string {
  const path = routePath(r);
  return r.area === 'project' && r.search ? `${path}${r.search}` : path;
}

/** True when two routes describe the same URL (path and query). */
export function routesEqual(a: Route, b: Route): boolean {
  if (a.area !== b.area) return false;
  if (a.area === 'admin' && b.area === 'admin') return a.view === b.view;
  if (a.area === 'legal' && b.area === 'legal') return a.view === b.view;
  if (a.area !== 'project' || b.area !== 'project') return true;
  return (
    a.projectId === b.projectId &&
    a.view === b.view &&
    a.sub === b.sub &&
    a.sub2 === b.sub2 &&
    a.search === b.search
  );
}

/**
 * True when both routes are the unified workspace of the same project. Such a
 * transition reuses the one mounted document session (the shell is keyed by
 * project id), so it is not a document-leaving transition and does not need the
 * route barrier; a document switch it may trigger is still guarded by the
 * session's own barrier.
 */
export function isSameWorkspaceSession(a: Route, b: Route): boolean {
  return (
    a.area === 'project' &&
    b.area === 'project' &&
    a.projectId === b.projectId &&
    a.view === 'workspace' &&
    b.view === 'workspace'
  );
}

/**
 * Canonical workspace target for a retired project view (R5.4.7, R5.5.5).
 *
 * The former `content`, `compose` and `designer` project views are superseded by
 * the unified workspace route. This maps them deterministically onto
 * `/p/:projectId/workspace/:mode[/:contentId]` so `App` can redirect old links
 * instead of rendering a second implementation. Returns null for routes that are
 * already canonical or unrelated.
 */
export function canonicalWorkspaceRoute(route: Route): Route | null {
  if (route.area !== 'project') return null;
  if (route.view === 'compose') {
    return { area: 'project', projectId: route.projectId, view: 'workspace', sub: 'composer', sub2: null, search: '' };
  }
  if (route.view === 'content') {
    return { area: 'project', projectId: route.projectId, view: 'workspace', sub: 'editor', sub2: route.sub, search: '' };
  }
  if (route.view === 'designer') {
    return { area: 'project', projectId: route.projectId, view: 'workspace', sub: 'designer', sub2: null, search: '' };
  }
  return null;
}
