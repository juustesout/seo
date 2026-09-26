/**
 * Project workspace route model (R5.3).
 *
 * Hand-rolled history routing shared by `App.tsx`. A project route is
 * `/p/:projectId/:view[/:sub[/:sub2]]`: `view` selects a project surface, and
 * up to two sub-segments let a surface own URL-based sections
 * (`/p/:id/knowledge/sources`) or the unified workspace carry a mode plus a
 * document id (`/p/:id/workspace/:mode/:contentId`).
 */
export type TopArea = 'overview' | 'projects' | 'compose' | 'integrations' | 'keys';

export type Route =
  | { area: TopArea }
  | { area: 'project'; projectId: string; view: string; sub: string | null; sub2: string | null; search: string };

/** Derive the current Route from the URL. */
export function parseRoute(): Route {
  const seg = window.location.pathname.split('/').filter(Boolean);
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
  const area = seg[0] === 'projects' || seg[0] === 'compose' || seg[0] === 'integrations' || seg[0] === 'keys' ? seg[0] : 'overview';
  return { area };
}

/** Render a Route back to its canonical URL path. */
export function routePath(r: Route): string {
  if (r.area === 'project') return `/p/${r.projectId}/${r.view}${r.sub ? `/${r.sub}` : ''}${r.sub2 ? `/${r.sub2}` : ''}`;
  return `/${r.area === 'overview' ? 'overview' : r.area}`;
}

/**
 * Canonical workspace target for a retired project view (R5.4.7).
 *
 * The former `content` and `compose` project views are superseded by the unified
 * workspace route. This maps them deterministically onto
 * `/p/:projectId/workspace/:mode[/:contentId]` so `App` can redirect old links
 * instead of rendering a second Composer/editor implementation. The `designer`
 * view is intentionally left alone (R5.5 owns its retirement). Returns null for
 * routes that are already canonical or unrelated.
 */
export function canonicalWorkspaceRoute(route: Route): Route | null {
  if (route.area !== 'project') return null;
  if (route.view === 'compose') {
    return { area: 'project', projectId: route.projectId, view: 'workspace', sub: 'composer', sub2: null, search: '' };
  }
  if (route.view === 'content') {
    return { area: 'project', projectId: route.projectId, view: 'workspace', sub: 'editor', sub2: route.sub, search: '' };
  }
  return null;
}
