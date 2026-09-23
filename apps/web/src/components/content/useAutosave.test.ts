import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAutosave } from './useAutosave';

function mount(initialSnapshot: string, persist = vi.fn(async () => undefined)) {
  const view = renderHook(
    ({ snapshot }: { snapshot: string }) =>
      useAutosave({
        enabled: true,
        delayMs: 100,
        makeSnapshot: () => snapshot,
        snapshotKey: snapshot,
        persist,
      }),
    { initialProps: { snapshot: initialSnapshot } },
  );
  return { ...view, persist };
}

describe('useAutosave', () => {
  it('never saves before a baseline is set (untouched document)', async () => {
    vi.useFakeTimers();
    const { result, persist } = mount('{"t":"a"}');

    expect(result.current.status).toBe('saved');
    expect(result.current.dirty).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(persist).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('marks dirty and saves a changed snapshot exactly once', async () => {
    vi.useFakeTimers();
    const { result, rerender, persist } = mount('{"t":"a"}');

    act(() => result.current.setBaseline('{"t":"a"}'));
    rerender({ snapshot: '{"t":"b"}' });

    expect(result.current.dirty).toBe(true);
    expect(result.current.status).toBe('unsaved');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('{"t":"b"}');
    expect(result.current.dirty).toBe(false);
    expect(result.current.status).toBe('saved');

    // An unchanged value does not reschedule: no self-trigger loop.
    rerender({ snapshot: '{"t":"b"}' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(persist).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('debounces rapid edits into a single save of the latest value', async () => {
    vi.useFakeTimers();
    const { result, rerender, persist } = mount('{"t":"a"}');

    act(() => result.current.setBaseline('{"t":"a"}'));
    rerender({ snapshot: '{"t":"b"}' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    rerender({ snapshot: '{"t":"c"}' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    rerender({ snapshot: '{"t":"d"}' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('{"t":"d"}');

    vi.useRealTimers();
  });

  it('saves a newer edit that lands while a save is in flight', async () => {
    vi.useFakeTimers();
    let release = () => {};
    const persist = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result, rerender } = mount('{"t":"a"}', persist);

    act(() => result.current.setBaseline('{"t":"a"}'));
    rerender({ snapshot: '{"t":"b"}' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(persist).toHaveBeenCalledTimes(1);

    rerender({ snapshot: '{"t":"c"}' });
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith('{"t":"c"}');

    vi.useRealTimers();
  });

  it('reports a failed save without losing dirty state', async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => {
      throw new Error('offline');
    });
    const { result, rerender } = mount('{"t":"a"}', persist);

    act(() => result.current.setBaseline('{"t":"a"}'));
    rerender({ snapshot: '{"t":"b"}' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.dirty).toBe(true);

    vi.useRealTimers();
  });

  it('flush resolves without saving when there is nothing to persist', async () => {
    const { result, persist } = mount('{"t":"a"}');
    act(() => result.current.setBaseline('{"t":"a"}'));

    let ok = false;
    await act(async () => {
      ok = await result.current.flush();
    });

    expect(ok).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('flush saves pending edits immediately and resolves once settled', async () => {
    vi.useFakeTimers();
    const { result, rerender, persist } = mount('{"t":"a"}');
    act(() => result.current.setBaseline('{"t":"a"}'));
    rerender({ snapshot: '{"t":"b"}' });
    expect(result.current.dirty).toBe(true);

    let ok = false;
    await act(async () => {
      ok = await result.current.flush();
    });

    expect(ok).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('{"t":"b"}');
    expect(result.current.dirty).toBe(false);
    expect(result.current.status).toBe('saved');

    vi.useRealTimers();
  });

  it('flush waits for an in-flight save and includes edits that land during it', async () => {
    vi.useFakeTimers();
    const pending: Array<() => void> = [];
    const persist = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        }),
    );
    const { result, rerender } = mount('{"t":"a"}', persist);
    act(() => result.current.setBaseline('{"t":"a"}'));
    rerender({ snapshot: '{"t":"b"}' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(persist).toHaveBeenCalledTimes(1);

    rerender({ snapshot: '{"t":"c"}' });
    let ok: boolean | undefined;
    let flushPromise: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      flushPromise = result.current.flush().then((value) => {
        ok = value;
        return value;
      });
      await Promise.resolve();
    });
    // Still waiting on the in-flight save of the older snapshot.
    expect(ok).toBeUndefined();

    await act(async () => {
      pending.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The newer edit is persisted before the barrier can settle.
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith('{"t":"c"}');
    expect(ok).toBeUndefined();

    await act(async () => {
      pending.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushPromise;
    expect(ok).toBe(true);
    expect(result.current.dirty).toBe(false);

    vi.useRealTimers();
  });

  it('flush resolves false and stays dirty when the save fails', async () => {
    const persist = vi.fn(async () => {
      throw new Error('offline');
    });
    const { result, rerender } = mount('{"t":"a"}', persist);
    act(() => result.current.setBaseline('{"t":"a"}'));
    rerender({ snapshot: '{"t":"b"}' });

    let ok = true;
    await act(async () => {
      ok = await result.current.flush();
    });

    expect(ok).toBe(false);
    expect(result.current.dirty).toBe(true);
    expect(result.current.status).toBe('failed');
  });
});
