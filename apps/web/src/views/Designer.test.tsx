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
import { contentRevisionOf, tiptapEmptyDoc } from '@seo/contracts';
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

function visualProposal(text: string): DesignerProposal {
  return {
    version: 1,
    baseRevision: 'rev1:abc',
    document: doc(text),
    visual: {
      kind: 'visual_design_proposal',
      version: 1,
      operations: [{ op: 'select_asset', target: 'hero__media', mediaId: 'm_solar' }],
      rationale: ['Matched metadata on "solar".'],
      unmatched: [{ targetBlockId: 'feat__media', reason: 'below_threshold' }],
    },
  };
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

  it('shows the Visual domain rationale and unmatched targets as read-only provenance', async () => {
    const fake = fakeApi(run({ status: 'queued' }));
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);

    fireEvent.change(screen.getByLabelText('What should the Designer create?'), {
      target: { value: 'Add matching images from our library' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start design run' }));
    await screen.findByText('Queued');

    fake.setCurrent(run({ status: 'succeeded', result: visualProposal('Body with images') }));
    await screen.findByText('Body with images');

    expect(screen.getByText('Visual selections')).toBeTruthy();
    expect(screen.getByText(/Matched metadata on "solar"/)).toBeTruthy();
    expect(screen.getByText('feat__media')).toBeTruthy();
    expect(screen.getByText(/below_threshold/)).toBeTruthy();
    // Provenance is explanatory: it never adds an apply control of its own.
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
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

// ---------------------------------------------------------------------------
// Phase 5.2: edit mode, review, apply and reject
// ---------------------------------------------------------------------------

const CID = '33333333-3333-4333-8333-333333333333';
const CONTENT_DOC = tiptapEmptyDoc();
const REV = contentRevisionOf(CONTENT_DOC);
const CONTENT_LIST_PATH = `/projects/${PROJECT}/content?limit=300`;
const CONTENT_DETAIL_PATH = `/projects/${PROJECT}/content/${CID}`;
const APPLY_PATH = `/projects/${PROJECT}/content/${CID}/designer/apply`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

function editProposal(text: string, baseRevision = REV): DesignerProposal {
  return { version: 1, baseRevision, document: doc(text) };
}

function editRun(over: Partial<AgentRun> = {}): AgentRun {
  return run({
    input: { mode: 'intent', intent: { instruction: 'Improve it', projectId: PROJECT, contentId: CID } },
    ...over,
  });
}

function listRow() {
  return { id: CID, title: 'Existing article', status: 'draft', updated_at: '2026-01-01T00:00:00.000Z' };
}

interface EditApi {
  calls: Call[];
  setRun: (next: AgentRun) => void;
  isApplied: () => boolean;
}

/** Transport fake for the edit flow: list, detail, runs and apply. */
function editApi(
  initial: AgentRun,
  overrides: { contentJson?: unknown; onApply?: () => unknown } = {},
): EditApi {
  let currentRun = initial;
  const contentJson = overrides.contentJson ?? CONTENT_DOC;
  const calls: Call[] = [];
  let applied = false;
  apiMock.api.mockReset();
  apiMock.api.mockImplementation(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    if (path === CONTENT_LIST_PATH) return { content: [listRow()], total: 1 };
    if (path === CONTENT_DETAIL_PATH) {
      return { ...listRow(), content_json: contentJson };
    }
    if (method === 'POST' && path === RUNS_PATH) return { run: currentRun, reused: false };
    if (method === 'GET' && path.startsWith(`/projects/${PROJECT}/designer/runs/`)) return currentRun;
    if (method === 'POST' && path === APPLY_PATH) {
      if (overrides.onApply) return overrides.onApply();
      applied = true;
      return { id: CID };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return {
    calls,
    setRun: (next) => {
      currentRun = next;
    },
    isApplied: () => applied,
  };
}

async function selectEditDocument() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit existing' }));
  await screen.findByText('Existing article (draft)');
  fireEvent.change(screen.getByLabelText('Select document'), { target: { value: CID } });
  await screen.findByText('Existing article');
}

async function startEditRun(instruction = 'Tighten the introduction') {
  fireEvent.change(screen.getByLabelText('How should the Designer change this document?'), {
    target: { value: instruction },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start design run' }));
}

describe('Designer edit + apply', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMock.api.mockReset();
  });

  it('switches to edit mode, lists documents and shows the selected revision', async () => {
    editApi(editRun({ status: 'queued' }));
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    expect(screen.getByLabelText('What should the Designer create?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit existing' }));
    await screen.findByText('Existing article (draft)');
    expect(screen.getByLabelText('How should the Designer change this document?')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Select document'), { target: { value: CID } });
    await screen.findByText(REV);
    expect(screen.getByText('Existing article')).toBeTruthy();
  });

  it('submits an edit run with the document id and no client base revision', async () => {
    const fake = editApi(editRun({ status: 'queued' }));
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    await selectEditDocument();
    await startEditRun('Tighten the introduction');

    await screen.findByText('Queued');
    const post = pathsOf(fake.calls, 'POST').find((c) => c.path === RUNS_PATH)!;
    expect(post.body).toMatchObject({
      mode: 'intent',
      instruction: 'Tighten the introduction',
      content_id: CID,
    });
    expect('base_revision' in (post.body as object)).toBe(false);
    expect(window.localStorage.getItem(BOOKMARK_KEY)).toBe(RUN_ID);
  });

  it('will not start an edit run without a document', async () => {
    editApi(editRun({ status: 'queued' }));
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit existing' }));
    await screen.findByText('Existing article (draft)');
    fireEvent.change(screen.getByLabelText('How should the Designer change this document?'), {
      target: { value: 'Tighten the introduction' },
    });

    expect((screen.getByRole('button', { name: 'Start design run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Select a document before starting an edit run.')).toBeTruthy();
  });

  it('enters review for a succeeded edit run with source identity and proposal', async () => {
    editApi(editRun({ status: 'succeeded', result: editProposal('Edited proposal body') }));
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    await selectEditDocument();
    await startEditRun();

    await screen.findByText('Edited proposal body');
    expect(screen.getByText('Proposed document')).toBeTruthy();
    expect(screen.getByText('Current saved document')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply to document' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.getAllByText(REV).length).toBeGreaterThan(0);
  });

  it('applies the proposal with its revision and refreshes the document', async () => {
    const fake = editApi(editRun({ status: 'succeeded', result: editProposal('Edited proposal body') }));
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    await selectEditDocument();
    await startEditRun();
    await screen.findByText('Edited proposal body');

    const detailReadsBefore = fake.calls.filter((c) => c.method === 'GET' && c.path === CONTENT_DETAIL_PATH).length;
    fireEvent.click(screen.getByRole('button', { name: 'Apply to document' }));

    await screen.findByText('Proposal applied to the saved document.');
    const apply = pathsOf(fake.calls, 'POST').find((c) => c.path === APPLY_PATH)!;
    expect((apply.body as { proposal: DesignerProposal }).proposal.baseRevision).toBe(REV);
    expect(fake.isApplied()).toBe(true);
    await waitFor(() =>
      expect(
        fake.calls.filter((c) => c.method === 'GET' && c.path === CONTENT_DETAIL_PATH).length,
      ).toBeGreaterThan(detailReadsBefore),
    );
  });

  it('reports a stale proposal refused by the server without marking it applied', async () => {
    const fake = editApi(editRun({ status: 'succeeded', result: editProposal('Edited proposal body') }), {
      onApply: () => {
        throw new ApiRequestError(
          'stale_proposal',
          'The content changed since this proposal was generated; generate it again.',
          409,
        );
      },
    });
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    await selectEditDocument();
    await startEditRun();
    await screen.findByText('Edited proposal body');

    fireEvent.click(screen.getByRole('button', { name: 'Apply to document' }));
    await screen.findByText('This proposal is stale and was not applied.');
    expect(screen.getByText(/The content changed since this proposal was generated/)).toBeTruthy();
    expect(fake.isApplied()).toBe(false);
  });

  it('disables apply when the source document no longer matches the proposal', async () => {
    const changedDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'changed' }] }] };
    editApi(editRun({ status: 'succeeded', result: editProposal('Edited proposal body') }), {
      contentJson: changedDoc,
    });
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    await selectEditDocument();
    await startEditRun();
    await screen.findByText('Edited proposal body');

    expect(
      (screen.getByRole('button', { name: 'Apply to document' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/The saved document changed after this proposal was generated/)).toBeTruthy();
  });

  it('cannot apply the same proposal twice', async () => {
    const applyDeferred = deferred<unknown>();
    let applyCalls = 0;
    apiMock.api.mockReset();
    apiMock.api.mockImplementation(
      async (path: string, opts: { method?: string; body?: unknown } = {}) => {
        const method = opts.method ?? 'GET';
        if (path === CONTENT_LIST_PATH) return { content: [listRow()], total: 1 };
        if (path === CONTENT_DETAIL_PATH) return { ...listRow(), content_json: CONTENT_DOC };
        if (method === 'POST' && path === RUNS_PATH) {
          return { run: editRun({ status: 'succeeded', result: editProposal('Edited proposal body') }), reused: false };
        }
        if (method === 'POST' && path === APPLY_PATH) {
          applyCalls += 1;
          return applyDeferred.promise;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    );
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    await selectEditDocument();
    await startEditRun();
    await screen.findByText('Edited proposal body');

    const button = screen.getByRole('button', { name: 'Apply to document' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(applyCalls).toBe(1));
    applyDeferred.resolve({ id: CID });
    await screen.findByText('Proposal applied to the saved document.');
  });

  it('rejects a proposal without modifying the saved content', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fake = editApi(editRun({ status: 'succeeded', result: editProposal('Edited proposal body') }));
    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    await selectEditDocument();
    await startEditRun();
    await screen.findByText('Edited proposal body');

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await screen.findByText('Proposal rejected. The saved document was not changed.');
    expect(confirmSpy).toHaveBeenCalled();
    expect(fake.isApplied()).toBe(false);
    expect(pathsOf(fake.calls, 'POST').some((c) => c.path === APPLY_PATH)).toBe(false);

    confirmSpy.mockRestore();
  });

  it('never lets a stale document response overwrite a newer selection', async () => {
    const docA = '44444444-4444-4444-8444-444444444444';
    const docB = '55555555-5555-4555-8555-555555555555';
    const pendingA = deferred<unknown>();
    apiMock.api.mockReset();
    apiMock.api.mockImplementation(async (path: string, opts: { method?: string } = {}) => {
      const method = opts.method ?? 'GET';
      if (path === CONTENT_LIST_PATH) {
        return {
          content: [
            { id: docA, title: 'Doc A', status: 'draft', updated_at: null },
            { id: docB, title: 'Doc B', status: 'draft', updated_at: null },
          ],
          total: 2,
        };
      }
      if (path === `/projects/${PROJECT}/content/${docA}`) return pendingA.promise;
      if (path === `/projects/${PROJECT}/content/${docB}`) {
        return { id: docB, title: 'Doc B', status: 'draft', updated_at: null, content_json: CONTENT_DOC };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    render(<Designer projectId={PROJECT} role="editor" pollMs={5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit existing' }));
    await screen.findByText('Doc A (draft)');

    fireEvent.change(screen.getByLabelText('Select document'), { target: { value: docA } });
    fireEvent.change(screen.getByLabelText('Select document'), { target: { value: docB } });
    await screen.findByText('Doc B');

    pendingA.resolve({ id: docA, title: 'Doc A', status: 'draft', updated_at: null, content_json: CONTENT_DOC });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText('Doc B')).toBeTruthy();
    expect(screen.queryByText('Doc A')).toBeNull();
  });
});
