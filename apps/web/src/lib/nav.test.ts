/**
 * R5.9 navigation: `openProjectView` is how the workspace header and project
 * views deep-link. It must cross the workspace save barrier before it pushes a
 * route, so leaving an open document flushes (and can be refused on save
 * failure) exactly like the App's own navigation helpers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { registerNavigationBarrier } from './navigationBarrier';
import { openProjectView } from './nav';

const original = window.location.href;

afterEach(() => {
  registerNavigationBarrier(null);
  window.history.pushState({}, '', original);
});

describe('openProjectView', () => {
  it('pushes the project view when no barrier refuses', async () => {
    await expect(openProjectView('p1', 'publications', { content_id: 'c9' })).resolves.toBe(true);
    expect(window.location.pathname).toBe('/p/p1/publications');
    expect(window.location.search).toBe('?content_id=c9');
  });

  it('does not navigate while the workspace save barrier refuses', async () => {
    registerNavigationBarrier(async () => false);
    await expect(openProjectView('p2', 'calendar')).resolves.toBe(false);
    expect(window.location.pathname).not.toBe('/p/p2/calendar');
  });
});
