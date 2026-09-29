/**
 * Dashboard project-scope test (R5.11.2 H4).
 *
 * The header project switcher re-renders the same Dashboard with a new
 * projectId. The view must not paint the previous project's payload while the
 * new one loads. The API module is mocked; `useAsync` runs for real.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Dashboard } from './Dashboard';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../lib/api', () => ({
  api: (...args: unknown[]) => apiMock.api(...args),
}));

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

function dash(query: string) {
  return {
    performance: { last_7d: 1, last_28d: 2, impressions_28d: 3, days: 28 },
    counts: { keywords: 0, pages: 0, ranking_rows_28d: 0 },
    top_queries: [{ query, clicks: 1, impressions: 1, position: 1 }],
    sources: { integrations: [], data_sources: [], last_sync_at: null },
    features: {},
  };
}

const GSC_STATE = { google: { connected: false, status: null }, current: null };

describe('Dashboard project switch', () => {
  it('never renders the previous project payload after projectId changes', async () => {
    const a = deferred<ReturnType<typeof dash>>();
    const b = deferred<ReturnType<typeof dash>>();
    apiMock.api.mockImplementation((path: string) => {
      if (path.endsWith('/jobs?limit=30')) return Promise.resolve([]);
      if (path.endsWith('/gsc/state')) return Promise.resolve(GSC_STATE);
      if (path === '/projects/p-a/dashboard') return a.promise;
      if (path === '/projects/p-b/dashboard') return b.promise;
      throw new Error(`unexpected api path: ${path}`);
    });

    const { rerender } = render(<Dashboard projectId="p-a" onOpenSettings={() => {}} />);
    await act(async () => {
      a.resolve(dash('alpha-unique'));
    });
    expect(await screen.findByText('alpha-unique')).toBeTruthy();

    rerender(<Dashboard projectId="p-b" onOpenSettings={() => {}} />);
    expect(screen.queryByText('alpha-unique')).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();

    await act(async () => {
      b.resolve(dash('bravo-unique'));
    });
    expect(await screen.findByText('bravo-unique')).toBeTruthy();
    expect(screen.queryByText('alpha-unique')).toBeNull();
  });
});
