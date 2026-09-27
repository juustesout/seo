/**
 * R5.9 navigation barrier: the workspace exposes its autosave flush to route
 * navigation so leaving an open document crosses the R5.6 save barrier. The
 * registry is intentionally tiny; these tests pin its contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerNavigationBarrier, runNavigationBarrier } from './navigationBarrier';

afterEach(() => {
  registerNavigationBarrier(null);
});

describe('navigation barrier', () => {
  it('allows navigation when no workspace has registered a barrier', async () => {
    await expect(runNavigationBarrier()).resolves.toBe(true);
  });

  it('returns the registered barrier result', async () => {
    const allow = vi.fn(async () => true);
    registerNavigationBarrier(allow);
    await expect(runNavigationBarrier()).resolves.toBe(true);
    expect(allow).toHaveBeenCalledTimes(1);
  });

  it('refuses navigation when the barrier reports an unsaved document', async () => {
    registerNavigationBarrier(async () => false);
    await expect(runNavigationBarrier()).resolves.toBe(false);
  });

  it('refuses navigation when the barrier throws rather than proceeding past it', async () => {
    registerNavigationBarrier(async () => {
      throw new Error('save failed');
    });
    await expect(runNavigationBarrier()).resolves.toBe(false);
  });

  it('stops consulting a barrier after it is cleared', async () => {
    const stale = vi.fn(async () => false);
    registerNavigationBarrier(stale);
    registerNavigationBarrier(null);
    await expect(runNavigationBarrier()).resolves.toBe(true);
    expect(stale).not.toHaveBeenCalled();
  });
});
