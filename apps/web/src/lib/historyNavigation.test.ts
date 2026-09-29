/**
 * R5.11.1 route transitions: the one controller behind both programmatic
 * navigation and browser Back/Forward. Every document-leaving transition must
 * cross the workspace save barrier; a refused `popstate` must restore the URL the
 * workspace is still showing without growing the history stack or looping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRE_GATED_POP_STATE, createRouteNavigation } from './historyNavigation';
import { parseRoute, type Route } from './projectRoute';

const original = window.location.href;

afterEach(() => {
  window.history.pushState({}, '', original);
});

function harness(initialPath: string, runBarrier: () => Promise<boolean> = vi.fn(async () => true)) {
  window.history.pushState({}, '', initialPath);
  let current: Route = parseRoute();
  const setRoute = vi.fn((next: Route) => {
    current = next;
  });
  const nav = createRouteNavigation({ getRoute: () => current, setRoute, runBarrier });
  return { nav, setRoute, runBarrier, get current() { return current; } };
}

describe('createRouteNavigation navigate', () => {
  it('crosses the barrier, then pushes and commits the route', async () => {
    const h = harness('/p/p1/dashboard');
    await expect(h.nav.navigate({ area: 'usage' })).resolves.toBe(true);
    expect(h.runBarrier).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/usage');
    expect(h.setRoute).toHaveBeenCalledWith({ area: 'usage' });
  });

  it('refuses and leaves the URL and route untouched when the barrier fails', async () => {
    const h = harness('/p/p1/workspace/editor/d1', vi.fn(async () => false));
    await expect(h.nav.navigate({ area: 'usage' })).resolves.toBe(false);
    expect(window.location.pathname).toBe('/p/p1/workspace/editor/d1');
    expect(h.setRoute).not.toHaveBeenCalled();
  });

  it('skips the barrier for a same-project workspace change', async () => {
    const h = harness('/p/p1/workspace/editor/d1');
    const ok = await h.nav.navigate({
      area: 'project',
      projectId: 'p1',
      view: 'workspace',
      sub: 'composer',
      sub2: null,
      search: '',
    });
    expect(ok).toBe(true);
    expect(h.runBarrier).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/p/p1/workspace/composer');
  });

  it('drops a second navigation while the first is awaiting the barrier', async () => {
    let release: (value: boolean) => void = () => {};
    const runBarrier = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
    const h = harness('/p/p1/workspace/editor/d1', runBarrier);
    const first = h.nav.navigate({ area: 'usage' });
    await expect(h.nav.navigate({ area: 'keys' })).resolves.toBe(false);
    release(true);
    await expect(first).resolves.toBe(true);
    expect(h.setRoute).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/usage');
  });
});

describe('createRouteNavigation handlePop', () => {
  it('applies an allowed pop through the barrier', async () => {
    const h = harness('/p/p1/workspace/editor/d1');
    window.history.pushState({}, '', '/p/p1/dashboard');
    await expect(h.nav.handlePop(new PopStateEvent('popstate'))).resolves.toBe(true);
    expect(h.runBarrier).toHaveBeenCalledTimes(1);
    expect(h.setRoute).toHaveBeenCalledWith({
      area: 'project',
      projectId: 'p1',
      view: 'dashboard',
      sub: null,
      sub2: null,
      search: '',
    });
  });

  it('waits for an in-progress save before committing', async () => {
    let release: (value: boolean) => void = () => {};
    const runBarrier = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
    const h = harness('/p/p1/workspace/editor/d1', runBarrier);
    window.history.pushState({}, '', '/p/p1/dashboard');
    const pending = h.nav.handlePop(new PopStateEvent('popstate'));
    expect(h.setRoute).not.toHaveBeenCalled();
    release(true);
    await expect(pending).resolves.toBe(true);
    expect(h.setRoute).toHaveBeenCalledTimes(1);
  });

  it('restores the URL in place on refusal without growing history or looping', async () => {
    const runBarrier = vi.fn(async () => false);
    const h = harness('/p/p1/workspace/editor/d1', runBarrier);
    window.history.pushState({}, '', '/p/p1/dashboard');
    const lengthAtPop = window.history.length;

    await expect(h.nav.handlePop(new PopStateEvent('popstate'))).resolves.toBe(false);
    expect(window.location.pathname).toBe('/p/p1/workspace/editor/d1');
    expect(window.history.length).toBe(lengthAtPop);
    expect(h.setRoute).not.toHaveBeenCalled();

    // The next pop is for the route now shown: a no-op that never re-runs the
    // barrier, so a refused Back/Forward cannot loop.
    await expect(h.nav.handlePop(new PopStateEvent('popstate'))).resolves.toBe(true);
    expect(runBarrier).toHaveBeenCalledTimes(1);
    expect(h.setRoute).not.toHaveBeenCalled();
  });

  it('skips the barrier for a same-project workspace change', async () => {
    const h = harness('/p/p1/workspace/editor/d1');
    window.history.pushState({}, '', '/p/p1/workspace/composer');
    await expect(h.nav.handlePop(new PopStateEvent('popstate'))).resolves.toBe(true);
    expect(h.runBarrier).not.toHaveBeenCalled();
    expect(h.setRoute).toHaveBeenCalledTimes(1);
  });

  it('applies a pre-gated pop without re-crossing the barrier', async () => {
    const h = harness('/p/p1/workspace/editor/d1');
    window.history.pushState({}, '', '/p/p1/publications');
    const event = new PopStateEvent('popstate', { state: { [PRE_GATED_POP_STATE]: true } });
    await expect(h.nav.handlePop(event)).resolves.toBe(true);
    expect(h.runBarrier).not.toHaveBeenCalled();
    expect(h.setRoute).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the pop already matches the rendered route', async () => {
    const h = harness('/p/p1/dashboard');
    await expect(h.nav.handlePop(new PopStateEvent('popstate'))).resolves.toBe(true);
    expect(h.runBarrier).not.toHaveBeenCalled();
    expect(h.setRoute).not.toHaveBeenCalled();
  });
});
