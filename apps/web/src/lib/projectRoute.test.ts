/**
 * R5.3 route contract: the unified workspace route is
 * `/p/:projectId/workspace/:mode/:contentId`, with the former
 * `content`/`compose`/`designer` project views still parseable so old links are
 * not lost. R5.4.7 retired `content`/`compose`: they stay parseable only so
 * `canonicalWorkspaceRoute` can redirect them (see App) rather than render a
 * second Composer/editor. `parseRoute` reads what `routePath` writes.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { canonicalWorkspaceRoute, parseRoute, routePath, type Route } from './projectRoute';

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
  });

  it('leaves canonical, designer and account routes untouched', () => {
    for (const view of ['workspace', 'designer', 'dashboard'] as const) {
      expect(
        canonicalWorkspaceRoute({ area: 'project', projectId: 'p', view, sub: null, sub2: null, search: '' }),
      ).toBeNull();
    }
    expect(canonicalWorkspaceRoute({ area: 'compose' })).toBeNull();
    expect(canonicalWorkspaceRoute({ area: 'overview' })).toBeNull();
  });
});
