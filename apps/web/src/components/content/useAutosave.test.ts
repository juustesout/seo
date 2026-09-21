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
});
