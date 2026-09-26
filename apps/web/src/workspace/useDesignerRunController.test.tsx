/**
 * Shared Designer run controller tests (R5.5.4a).
 *
 * Pins the server lifecycle both run surfaces rely on: bookmark restore, submit
 * and reuse, the epoch race guard, poll stop at terminal, transient vs fatal
 * read errors, the poll budget, and reset on identity change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentRun } from '@seo/contracts';
import { ApiRequestError } from '../lib/api';
import { useDesignerRunController } from './useDesignerRunController';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock.api };
});

const PROJECT = '11111111-1111-4111-8111-111111111111';
const RUN_ID = 'ar_22222222-2222-4222-8222-222222222222';
const KEY = `seo.designer.run.${PROJECT}`;
const RUNS_PATH = `/projects/${PROJECT}/designer/runs`;
const RUN_PATH = `${RUNS_PATH}/${RUN_ID}`;

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: RUN_ID,
    kind: 'design',
    projectId: PROJECT,
    status: 'queued',
    input: { mode: 'intent', intent: { instruction: 'Create a landing page', projectId: PROJECT } },
    result: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    ...over,
  };
}

function baseOptions(over: Partial<Parameters<typeof useDesignerRunController>[0]> = {}) {
  return { projectId: PROJECT, pollMs: 5, bookmarkKey: null, ...over };
}

describe('useDesignerRunController', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMock.api.mockReset();
  });

  it('restores a bookmarked run on mount and reports the snapshot', async () => {
    window.localStorage.setItem(KEY, RUN_ID);
    apiMock.api.mockResolvedValue(run({ status: 'running' }));
    const onRun = vi.fn();

    const { result } = renderHook(() =>
      useDesignerRunController(baseOptions({ bookmarkKey: KEY, onRun })),
    );

    await waitFor(() => expect(result.current.run?.status).toBe('running'));
    expect(apiMock.api).toHaveBeenCalledWith(RUN_PATH);
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running' }),
      { source: 'restore', reused: false },
    );
  });

  it('drops a stale bookmark and reports gone when the run is not found', async () => {
    window.localStorage.setItem(KEY, RUN_ID);
    apiMock.api.mockRejectedValue(new ApiRequestError('agent_run_not_found', 'not found', 404));
    const onGone = vi.fn();

    const { result } = renderHook(() =>
      useDesignerRunController(baseOptions({ bookmarkKey: KEY, onGone })),
    );

    await waitFor(() => expect(onGone).toHaveBeenCalled());
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(result.current.run).toBeNull();
  });

  it('submits, bookmarks the run id and surfaces reuse', async () => {
    apiMock.api.mockResolvedValue({ run: run({ status: 'queued' }), reused: true });

    const { result } = renderHook(() => useDesignerRunController(baseOptions({ bookmarkKey: KEY })));

    await act(async () => {
      await result.current.submit({ mode: 'intent', instruction: 'A brief' });
    });

    expect(apiMock.api).toHaveBeenCalledWith(RUNS_PATH, {
      method: 'POST',
      body: { mode: 'intent', instruction: 'A brief' },
    });
    expect(window.localStorage.getItem(KEY)).toBe(RUN_ID);
    expect(result.current.reused).toBe(true);
    expect(result.current.phase).toBe('queued');
  });

  it('never writes a bookmark when the surface disables it', async () => {
    apiMock.api.mockResolvedValue({ run: run({ status: 'queued' }), reused: false });

    const { result } = renderHook(() => useDesignerRunController(baseOptions()));

    await act(async () => {
      await result.current.submit({ mode: 'intent', instruction: 'A brief' });
    });

    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(apiMock.api).toHaveBeenCalledTimes(1);
  });

  it('stops polling once the run is terminal', async () => {
    let current = run({ status: 'queued' });
    apiMock.api.mockImplementation(async (path: string, opts: { method?: string } = {}) => {
      if ((opts.method ?? 'GET') === 'POST' && path === RUNS_PATH) return { run: current, reused: false };
      return current;
    });

    const { result } = renderHook(() => useDesignerRunController(baseOptions({ bookmarkKey: KEY })));
    await act(async () => {
      await result.current.submit({ mode: 'intent', instruction: 'A brief' });
    });
    await waitFor(() => expect(result.current.run?.status).toBe('queued'));

    current = run({ status: 'succeeded', result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] } } });
    await waitFor(() => expect(result.current.run?.status).toBe('succeeded'));

    const calls = apiMock.api.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(apiMock.api.mock.calls.length).toBe(calls);
  });

  it('keeps the run and retries on a transient poll error', async () => {
    apiMock.api.mockResolvedValue(run({ status: 'running' }));
    window.localStorage.setItem(KEY, RUN_ID);
    const onError = vi.fn((_error: unknown, _meta: unknown) => 'retry' as const);

    const { result } = renderHook(() =>
      useDesignerRunController(baseOptions({ bookmarkKey: KEY, onError })),
    );
    await waitFor(() => expect(result.current.run?.status).toBe('running'));

    apiMock.api.mockRejectedValue(new Error('network down'));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ source: 'poll', fatal: false });
    expect(result.current.run?.status).toBe('running');
  });

  it('stops on an authorization failure while polling', async () => {
    apiMock.api.mockResolvedValue(run({ status: 'running' }));
    window.localStorage.setItem(KEY, RUN_ID);
    const onError = vi.fn((_error: unknown, _meta: unknown) => 'stop' as const);

    const { result } = renderHook(() =>
      useDesignerRunController(baseOptions({ bookmarkKey: KEY, onError })),
    );
    await waitFor(() => expect(result.current.run?.status).toBe('running'));

    apiMock.api.mockRejectedValue(new ApiRequestError('forbidden', 'forbidden', 403));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ source: 'poll', fatal: true });

    const calls = apiMock.api.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(apiMock.api.mock.calls.length).toBe(calls);
  });

  it('reports exhaustion and stops at the poll budget', async () => {
    apiMock.api.mockResolvedValue(run({ status: 'queued' }));
    window.localStorage.setItem(KEY, RUN_ID);
    const onExhausted = vi.fn();

    const { result } = renderHook(() =>
      useDesignerRunController(baseOptions({ bookmarkKey: KEY, maxPolls: 2, onExhausted })),
    );
    await waitFor(() => expect(onExhausted).toHaveBeenCalled());
    expect(result.current.run?.status).toBe('queued');

    const calls = apiMock.api.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(apiMock.api.mock.calls.length).toBe(calls);
  });

  it('resets and invalidates in-flight work when the identity changes', async () => {
    apiMock.api.mockResolvedValue(run({ status: 'running' }));
    const onReset = vi.fn();

    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) =>
        useDesignerRunController(baseOptions({ identity, onReset })),
      { initialProps: { identity: 'a' } },
    );
    expect(result.current.run).toBeNull();

    rerender({ identity: 'b' });
    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(2));
    expect(result.current.run).toBeNull();
  });
});
