/**
 * Shared data-hook tests (R5.11.2 H4).
 *
 * Pins the scope-freshness contract of `useAsync`: a change in the identity
 * deps drops the previous payload before the new one resolves, while a manual
 * `reload()` refreshes in place. The API is not involved; only the hook runs.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { JobTable, jobErrorText, useAsync } from './ui';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useAsync', () => {
  it('resolves the payload for the current deps', async () => {
    const load = vi.fn(async (id: string) => ({ id }));
    const { result } = renderHook(() => useAsync(() => load('p-1'), ['p-1']));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ id: 'p-1' }));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('drops the previous scope payload as soon as the deps change', async () => {
    const first = deferred<{ id: string }>();
    const second = deferred<{ id: string }>();
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useAsync(() => (id === 'p-1' ? first.promise : second.promise), [id]),
      { initialProps: { id: 'p-1' } },
    );

    await act(async () => {
      first.resolve({ id: 'p-1' });
    });
    expect(result.current.data).toEqual({ id: 'p-1' });

    rerender({ id: 'p-2' });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      second.resolve({ id: 'p-2' });
    });
    expect(result.current.data).toEqual({ id: 'p-2' });
  });

  it('keeps data during a manual reload so polling refreshes in place', async () => {
    let n = 0;
    const { result } = renderHook(() => useAsync(async () => ({ v: (n += 1) }), []));
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));

    act(() => result.current.reload());
    expect(result.current.data).toEqual({ v: 1 });

    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }));
  });

  it('ignores a late response from the previous deps run', async () => {
    const first = deferred<{ id: string }>();
    const second = deferred<{ id: string }>();
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useAsync(() => (id === 'p-1' ? first.promise : second.promise), [id]),
      { initialProps: { id: 'p-1' } },
    );

    rerender({ id: 'p-2' });
    await act(async () => {
      second.resolve({ id: 'p-2' });
    });
    expect(result.current.data).toEqual({ id: 'p-2' });

    await act(async () => {
      first.resolve({ id: 'p-1' });
    });
    expect(result.current.data).toEqual({ id: 'p-2' });
  });
});

describe('jobErrorText', () => {
  it('reduces a JobError object to its message', () => {
    expect(jobErrorText({ message: 'Provider rejected the request', code: 'invalid' })).toBe(
      'Provider rejected the request',
    );
  });

  it('passes a string error through and treats empties as null', () => {
    expect(jobErrorText('plain failure')).toBe('plain failure');
    expect(jobErrorText('   ')).toBeNull();
    expect(jobErrorText(null)).toBeNull();
  });

  it('falls back to a nested error message then null', () => {
    expect(jobErrorText({ error: 'nested failure' })).toBe('nested failure');
    expect(jobErrorText({ code: 'no-message' })).toBeNull();
  });
});

describe('JobTable', () => {
  it('renders a JobError message instead of [object Object]', () => {
    render(
      <JobTable
        jobs={[
          {
            id: 'j1',
            job_type: 'publish',
            status: 'failed',
            progress: 40,
            message: null,
            error: { message: 'Remote post could not be created', retryable: true, occurred_at: '2026-09-01T00:00:00Z' },
            created_at: '2026-09-01T00:00:00Z',
          },
        ]}
      />,
    );
    expect(screen.getByText('error: Remote post could not be created')).toBeTruthy();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });
});
