/**
 * Designer surface tests (Stage 8E.6, ADR Phase 5.1).
 *
 * These drive the view against the real durable-run wire shapes with the
 * transport module mocked, and assert the Phase 5.1 guarantees: one submission
 * per user action, honest queued/running/succeeded/failed states, a proposal
 * that is clearly not applied, refresh recovery of the bookmarked run, and that
 * a stale response can never overwrite a newer run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentRun, CanonicalDocument, DesignerProposal } from '@seo/contracts';
import { Designer } from './Designer';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock.api };
});

import { ApiRequestError } from '../lib/api';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const RUN_ID = 'ar_22222222-2222-4222-8222-222222222222';
const BOOKMARK_KEY = `seo.designer.run.${PROJECT}`;
const RUN_PATH = `/projects/${PROJECT}/designer/runs/${RUN_ID}`;
const RUNS_PATH = `/projects/${PROJECT}/designer/runs`;

function doc(text: string): CanonicalDocument {
  return { version: 1, blocks: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function proposal(text: string): DesignerProposal {
  return { version: 1, baseRevision: 'rev1:abc', document: doc(text) };
}

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

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

interface FakeApi {
  current: () => AgentRun;
  setCurrent: (next: AgentRun) => void;
  setReused: (value: boolean) => void;
  calls: Call[];
}

/** Stateful transport fake: GET returns the current run, POST tracks it. */
function fakeApi(initial: AgentRun): FakeApi {
  let current = initial;
  let reused = false;
  const calls: Call[] = [];
  apiMock.api.mockReset();
  apiMock.api.mockImplementation(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    if (method === 'POST' && path === RUNS_PATH) return { run: current, reused };
    return current;
  });
  return {
    current: () => current,
    setCurrent: (next) => {
      current = next;
    },
    setReused: (value) => {
      reused = value;
    },
    calls,
  };
}

function pathsOf(calls: Call[], method: string): Call[] {
  return calls.filter((c) => c.method === method);
}

describe('Designer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMock.api.mockReset();
  });

  it('renders the brief form and the idle state', () => {
    fakeApi(run());
    render(<Designer projectId={PROJECT} role="editor" />);
    expect(screen.getByLabelText('What should the Designer create?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start design run' })).toBeTruthy();
    expect(screen.getByText('Describe what you want and start a run. Its proposal will appear here.')).toBeTruthy();
  });

  it('gates starting a run to editors and above', () => {
    fakeApi(run());
    render(<Designer projectId={PROJECT} role="viewer" />);
    expect(screen.getByText('Editors and above can start a design run.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start design run' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits an intent run, tracks it and bookmarks the run id', async () => {
    const fake = fakeApi(run({ status: 'queued' }));
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);

    fireEvent.change(screen.getByLabelText('What should the Designer create?'), {
      target: { value: 'Create a pricing page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start design run' }));

    await screen.findByText('Queued');

    const posts = pathsOf(fake.calls, 'POST');
    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.path).toBe(RUNS_PATH);
    expect(post.body).toMatchObject({ mode: 'intent', instruction: 'Create a pricing page' });
    expect(typeof (post.body as { base_revision?: unknown }).base_revision).toBe('string');
    expect(window.localStorage.getItem(BOOKMARK_KEY)).toBe(RUN_ID);
    expect(screen.getByText(RUN_ID)).toBeTruthy();
  });

  it('does not double-submit while a submission is in flight', async () => {
    let resolvePost: (value: { run: AgentRun; reused: boolean }) => void = () => {};
    const pending = new Promise<{ run: AgentRun; reused: boolean }>((resolve) => {
      resolvePost = resolve;
    });
    apiMock.api.mockReset();
    apiMock.api.mockImplementation((path: string, opts: { method?: string } = {}) => {
      if ((opts.method ?? 'GET') === 'POST' && path === RUNS_PATH) return pending;
      return Promise.resolve(run());
    });

    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    fireEvent.change(screen.getByLabelText('What should the Designer create?'), {
      target: { value: 'A guide' },
    });
    const button = screen.getByRole('button', { name: 'Start design run' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() =>
      expect(apiMock.api.mock.calls.filter(([, o]) => (o as { method?: string })?.method === 'POST')).toHaveLength(1),
    );

    resolvePost({ run: run({ status: 'queued' }), reused: false });
    await screen.findByText('Queued');
  });

  it('reports when the server collapsed the submission onto an existing run', async () => {
    const fake = fakeApi(run({ status: 'queued' }));
    fake.setReused(true);
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);

    fireEvent.change(screen.getByLabelText('What should the Designer create?'), {
      target: { value: 'Create a pricing page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start design run' }));

    await screen.findByText(/already submitted/i);
  });

  it('polls queued -> running -> succeeded and renders the proposal', async () => {
    const fake = fakeApi(run({ status: 'queued' }));
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);

    fireEvent.change(screen.getByLabelText('What should the Designer create?'), {
      target: { value: 'Create a landing page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start design run' }));
    await screen.findByText('Queued');

    fake.setCurrent(run({ status: 'running' }));
    await screen.findByText('Running');

    fake.setCurrent(
      run({
        status: 'succeeded',
        result: proposal('Designer proposal body'),
        completedAt: '2026-01-01T00:05:00.000Z',
      }),
    );
    await screen.findByText('Designer proposal body');

    expect(screen.getByText('This is a proposal. It has not been applied, saved, or published.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
    // A succeeded run must be readable through the status endpoint.
    expect(pathsOf(fake.calls, 'GET').some((c) => c.path === RUN_PATH)).toBe(true);
  });

  it('stops polling once the run is terminal', async () => {
    const fake = fakeApi(run({ status: 'queued' }));
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);

    fireEvent.change(screen.getByLabelText('What should the Designer create?'), {
      target: { value: 'Create a landing page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start design run' }));
    await screen.findByText('Queued');

    fake.setCurrent(run({ status: 'succeeded', result: proposal('Done body') }));
    await screen.findByText('Done body');

    const before = fake.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fake.calls.length).toBe(before);
  });

  it('shows a failed run and allows starting over', async () => {
    const fake = fakeApi(
      run({
        status: 'failed',
        error: { code: 'agent_design_failed', message: 'The planner is unavailable.', retryable: true },
        completedAt: '2026-01-01T00:05:00.000Z',
      }),
    );
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);

    fireEvent.change(screen.getByLabelText('What should the Designer create?'), {
      target: { value: 'Create a landing page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start design run' }));

    await screen.findByText('The design run failed.');
    expect(screen.getByText('The planner is unavailable.')).toBeTruthy();
    expect(screen.getByText(/agent_design_failed/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start a new run' }));
    await screen.findByText('Describe what you want and start a run. Its proposal will appear here.');
    expect(window.localStorage.getItem(BOOKMARK_KEY)).toBeNull();
    expect(fake.current().status).toBe('failed');
  });

  it('restores a bookmarked run on mount and resumes polling', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, RUN_ID);
    const fake = fakeApi(run({ status: 'running' }));
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);

    await screen.findByText('Running');
    expect(screen.getByText(RUN_ID)).toBeTruthy();
    expect(pathsOf(fake.calls, 'GET')[0]?.path).toBe(RUN_PATH);
  });

  it('drops a stale bookmark when the run no longer exists', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, RUN_ID);
    apiMock.api.mockReset();
    apiMock.api.mockImplementation(async (path: string) => {
      if (path === RUN_PATH) throw new ApiRequestError('agent_run_not_found', 'Agent run not found', 404);
      return run();
    });

    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);

    await screen.findByText('This design run is no longer available.');
    expect(window.localStorage.getItem(BOOKMARK_KEY)).toBeNull();
    expect(screen.getByRole('button', { name: 'Start design run' })).toBeTruthy();
  });

  it('never lets a stale restore response overwrite a newer submission', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, RUN_ID);
    let resolveGet: (value: AgentRun) => void = () => {};
    let resolvePost: (value: { run: AgentRun; reused: boolean }) => void = () => {};
    const pendingGet = new Promise<AgentRun>((resolve) => {
      resolveGet = resolve;
    });
    const pendingPost = new Promise<{ run: AgentRun; reused: boolean }>((resolve) => {
      resolvePost = resolve;
    });
    apiMock.api.mockReset();
    apiMock.api.mockImplementation((path: string, opts: { method?: string } = {}) => {
      if ((opts.method ?? 'GET') === 'POST') return pendingPost;
      return pendingGet;
    });

    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    fireEvent.change(screen.getByLabelText('What should the Designer create?'), {
      target: { value: 'A fresh brief' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start design run' }));

    resolvePost({ run: run({ status: 'succeeded', result: proposal('New run body') }), reused: false });
    await screen.findByText('New run body');

    resolveGet(run({ status: 'running' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText('New run body')).toBeTruthy();
    expect(screen.queryByText('Running')).toBeNull();
  });

  it('keeps the run visible when a refresh fails transiently', async () => {
    const fake = fakeApi(run({ status: 'running' }));
    window.localStorage.setItem(BOOKMARK_KEY, RUN_ID);
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    await screen.findByText('Running');

    fake.setCurrent(run({ status: 'running' }));
    apiMock.api.mockImplementation(async (path: string, opts: { method?: string } = {}) => {
      if ((opts.method ?? 'GET') === 'GET' && path === RUN_PATH) throw new Error('network down');
      return fake.current();
    });

    await screen.findByText(/Connection problem while refreshing the run/);
    expect(screen.getByText(RUN_ID)).toBeTruthy();
  });
});
