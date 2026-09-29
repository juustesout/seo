/**
 * R5.11.1 exit guard: reload/close cannot be intercepted, so the browser's
 * native `beforeunload` prompt is installed only while the workspace is dirty and
 * removed as soon as it is saved. The hook persists nothing and never claims a
 * completed save.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUnloadGuard } from './unloadGuard';

function dispatchBeforeUnload(): { prevented: boolean; returnValue: unknown } {
  // jsdom does not expose a constructible `BeforeUnloadEvent`, so dispatch a
  // cancellable generic event and read the default-prevented flag the handler
  // sets through `preventDefault()`.
  const event = new Event('beforeunload', { cancelable: true });
  const prevented = !window.dispatchEvent(event);
  return { prevented, returnValue: (event as unknown as { returnValue: unknown }).returnValue };
}

describe('useUnloadGuard', () => {
  it('does not warn while the document is clean', () => {
    renderHook(({ dirty }: { dirty: boolean }) => useUnloadGuard(dirty), { initialProps: { dirty: false } });
    expect(dispatchBeforeUnload().prevented).toBe(false);
  });

  it('warns natively while the document is dirty', () => {
    renderHook(({ dirty }: { dirty: boolean }) => useUnloadGuard(dirty), { initialProps: { dirty: true } });
    const result = dispatchBeforeUnload();
    expect(result.prevented).toBe(true);
    // The handler also sets the legacy `returnValue`; jsdom surfaces the cancel
    // through `defaultPrevented` above.
    expect(result.returnValue).toBeFalsy();
  });

  it('removes the warning as soon as the document is saved', () => {
    const view = renderHook(({ dirty }: { dirty: boolean }) => useUnloadGuard(dirty), {
      initialProps: { dirty: true },
    });
    expect(dispatchBeforeUnload().prevented).toBe(true);
    act(() => view.rerender({ dirty: false }));
    expect(dispatchBeforeUnload().prevented).toBe(false);
  });

  it('installs and removes exactly one listener as dirty flips', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const only = (calls: unknown[][]) => calls.filter(([type]) => type === 'beforeunload');

    const view = renderHook(({ dirty }: { dirty: boolean }) => useUnloadGuard(dirty), {
      initialProps: { dirty: false },
    });
    expect(only(add.mock.calls)).toHaveLength(0);

    act(() => view.rerender({ dirty: true }));
    expect(only(add.mock.calls)).toHaveLength(1);

    act(() => view.rerender({ dirty: false }));
    expect(only(remove.mock.calls)).toHaveLength(1);

    add.mockRestore();
    remove.mockRestore();
  });
});
