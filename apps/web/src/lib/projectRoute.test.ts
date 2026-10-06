/**
 * R5.3 route contract: the unified workspace route is
 * `/p/:projectId/workspace/:mode/:contentId`, with the former
 * `content`/`compose`/`designer` project views still parseable so old links are
 * not lost. R5.4.7 retired `content`/`compose` and R5.5.5 retired `designer`:
 * they stay parseable only so `canonicalWorkspaceRoute` can redirect them (see
 * App) rather than render a second implementation. `parseRoute` reads what
 * `routePath` writes.
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  canonicalWorkspaceRoute,
  isSameWorkspaceSession,
  parseRoute,
  routePath,
  routesEqual,
  routeUrl,
  type Route,
} from './projectRoute';

const original = window.location.href;

function at(path: string) {
  window.history.pushState({}, '', path);
}

afterEach(() => {
  window.history.pushState({}, '', original);
});

describe('project route contract', () => {
  it('parses workspace mode and content id from the canonical route', () => {
    at('/p/proj-1/workspace/designer/doc-9');
    expect(parseRoute()).toEqual({
      area: 'project',
      projectId: 'proj-1',
      view: 'workspace',
      sub: 'designer',
      sub2: 'doc-9',
      search: '',
    });
  });

  it('parses a mode-only workspace route', () => {
    at('/p/proj-1/workspace');
    expect(parseRoute()).toMatchObject({ view: 'workspace', sub: null, sub2: null });
  });

  it('keeps the legacy content route with its document id', () => {
    at('/p/proj-1/content/doc-3');
    expect(parseRoute()).toMatchObject({ view: 'content', sub: 'doc-3', sub2: null });
  });

  it('keeps the legacy compose and designer routes', () => {
    at('/p/proj-1/compose');
    expect(parseRoute()).toMatchObject({ view: 'compose' });
    at('/p/proj-1/designer');
    expect(parseRoute()).toMatchObject({ view: 'designer' });
  });

  it('round-trips a project route through routePath', () => {
    const route: Route = {
      area: 'project',
      projectId: 'proj-1',
      view: 'workspace',
      sub: 'editor',
      sub2: 'doc-7',
      search: '',
    };
    expect(routePath(route)).toBe('/p/proj-1/workspace/editor/doc-7');
    at(routePath(route));
    expect(parseRoute()).toEqual(route);
  });

  it('omits empty sub-segments and falls back to dashboard', () => {
    expect(routePath({ area: 'project', projectId: 'p', view: 'dashboard', sub: null, sub2: null, search: '' })).toBe('/p/p/dashboard');
    at('/p/p');
    expect(parseRoute()).toMatchObject({ view: 'dashboard', sub: null, sub2: null });
  });

  it('maps retired project views onto the canonical workspace route', () => {
    expect(
      canonicalWorkspaceRoute({ area: 'project', projectId: 'p', view: 'compose', sub: null, sub2: null, search: '' }),
    ).toEqual({ area: 'project', projectId: 'p', view: 'workspace', sub: 'composer', sub2: null, search: '' });
    expect(
      canonicalWorkspaceRoute({ area: 'project', projectId: 'p', view: 'content', sub: 'doc-3', sub2: null, search: '' }),
    ).toEqual({ area: 'project', projectId: 'p', view: 'workspace', sub: 'editor', sub2: 'doc-3', search: '' });
    expect(
      canonicalWorkspaceRoute({ area: 'project', projectId: 'p', view: 'designer', sub: null, sub2: null, search: '' }),
    ).toEqual({ area: 'project', projectId: 'p', view: 'workspace', sub: 'designer', sub2: null, search: '' });
  });

  it('leaves canonical and account routes untouched', () => {
    for (const view of ['workspace', 'dashboard'] as const) {
      expect(
        canonicalWorkspaceRoute({ area: 'project', projectId: 'p', view, sub: null, sub2: null, search: '' }),
      ).toBeNull();
    }
    expect(canonicalWorkspaceRoute({ area: 'compose' })).toBeNull();
    expect(canonicalWorkspaceRoute({ area: 'overview' })).toBeNull();
  });

  // R5.11.1 history restore helpers.

  it('routeUrl keeps a project route query so a restore does not drop filters', () => {
    expect(
      routeUrl({ area: 'project', projectId: 'p', view: 'publications', sub: null, sub2: null, search: '?content_id=c9' }),
    ).toBe('/p/p/publications?content_id=c9');
    expect(routeUrl({ area: 'project', projectId: 'p', view: 'workspace', sub: 'editor', sub2: 'd1', search: '' })).toBe(
      '/p/p/workspace/editor/d1',
    );
    expect(routeUrl({ area: 'usage' })).toBe('/usage');
  });

  it('routesEqual compares every field, including the query', () => {
    const a: Route = { area: 'project', projectId: 'p', view: 'workspace', sub: 'editor', sub2: 'd1', search: '' };
    expect(routesEqual(a, { ...a })).toBe(true);
    expect(routesEqual(a, { ...a, sub2: 'd2' })).toBe(false);
    expect(routesEqual(a, { ...a, search: '?x=1' })).toBe(false);
    expect(routesEqual({ area: 'projects' }, { area: 'projects' })).toBe(true);
    expect(routesEqual({ area: 'projects' }, { area: 'usage' })).toBe(false);
    expect(routesEqual(a, { area: 'projects' })).toBe(false);
  });

  it('isSameWorkspaceSession is true only for the same project workspace', () => {
    const editor: Route = { area: 'project', projectId: 'p', view: 'workspace', sub: 'editor', sub2: 'd1', search: '' };
    const composer: Route = { area: 'project', projectId: 'p', view: 'workspace', sub: 'composer', sub2: null, search: '' };
    expect(isSameWorkspaceSession(editor, composer)).toBe(true);
    expect(isSameWorkspaceSession(editor, { ...editor, projectId: 'q' })).toBe(false);
    expect(
      isSameWorkspaceSession(editor, { area: 'project', projectId: 'p', view: 'dashboard', sub: null, sub2: null, search: '' }),
    ).toBe(false);
    expect(isSameWorkspaceSession({ area: 'usage' }, composer)).toBe(false);
  });

  it('parses and renders the admin section without colliding with account areas', () => {
    at('/admin');
    expect(parseRoute()).toEqual({ area: 'admin', view: 'overview' });
    at('/admin/users');
    expect(parseRoute()).toEqual({ area: 'admin', view: 'users' });
    expect(routePath({ area: 'admin', view: 'overview' })).toBe('/admin');
    expect(routePath({ area: 'admin', view: 'usage' })).toBe('/admin/usage');
    const users: Route = { area: 'admin', view: 'users' };
    expect(routesEqual(users, { area: 'admin', view: 'users' })).toBe(true);
    expect(routesEqual(users, { area: 'admin', view: 'projects' })).toBe(false);
    expect(routesEqual(users, { area: 'overview' })).toBe(false);
    expect(routeUrl({ area: 'admin', view: 'users' })).toBe('/admin/users');
  });

  it('parses and renders the account plan area', () => {
    at('/plan');
    expect(parseRoute()).toEqual({ area: 'plan' });
    expect(routePath({ area: 'plan' })).toBe('/plan');
    expect(routeUrl({ area: 'plan' })).toBe('/plan');
  });

  it('parses and renders the public legal pages', () => {
    at('/privacy');
    expect(parseRoute()).toEqual({ area: 'legal', view: 'privacy' });
    at('/terms');
    expect(parseRoute()).toEqual({ area: 'legal', view: 'terms' });
    at('/cookies');
    expect(parseRoute()).toEqual({ area: 'legal', view: 'cookies' });
    expect(routePath({ area: 'legal', view: 'privacy' })).toBe('/privacy');
    expect(routePath({ area: 'legal', view: 'cookies' })).toBe('/cookies');
    expect(routesEqual({ area: 'legal', view: 'terms' }, { area: 'legal', view: 'terms' })).toBe(true);
    expect(routesEqual({ area: 'legal', view: 'terms' }, { area: 'legal', view: 'privacy' })).toBe(false);
    // A legal page is never confused with an account area or a project view.
    expect(routesEqual({ area: 'legal', view: 'privacy' }, { area: 'overview' })).toBe(false);
    expect(canonicalWorkspaceRoute({ area: 'legal', view: 'privacy' }) as unknown).toBeNull();
  });
});
