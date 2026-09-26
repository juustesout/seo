/**
 * Designer surface tests (Stage 8E.6, ADR Phase 5.1; workspace binding R5.5.1).
 *
 * The first block drives creation mode against the real durable-run wire shapes
 * with the transport module mocked, asserting the Phase 5.1 guarantees: one
 * submission per user action, honest queued/running/succeeded/failed states, a
 * proposal that is clearly not applied, refresh recovery of the bookmarked run,
 * and that a stale response can never overwrite a newer run.
 *
 * The second block covers edit mode after R5.5.1: the Designer no longer lists
 * or fetches documents. It edits the one open workspace document handed to it
 * by `DesignerMode` and binds the proposal to that document's live revision.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentRun, CanonicalDocument, DesignerProposal, DocumentOperation } from '@seo/contracts';
import { DOCUMENT_OPERATIONS_VERSION, contentRevisionOf, tiptapEmptyDoc } from '@seo/contracts';
import { Designer, type DesignerProps } from './Designer';

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
// R5.5.1: edit the shared workspace document (no own document read)
// ---------------------------------------------------------------------------

const CID = '33333333-3333-4333-8333-333333333333';
const CONTENT_DOC = tiptapEmptyDoc();
const REV = contentRevisionOf(CONTENT_DOC);
const APPLY_PATH = `/projects/${PROJECT}/content/${CID}/designer/apply`;
const CONTENT_LIST_PATH = `/projects/${PROJECT}/content?limit=300`;
const CONTENT_DETAIL_PATH = `/projects/${PROJECT}/content/${CID}`;

/** The shared document props `DesignerMode` supplies for the open document. */
const OPEN_DOCUMENT: Partial<DesignerProps> = {
  documentId: CID,
  documentTitle: 'Existing article',
  documentRevision: REV,
  documentStatus: 'ready',
  currentDocument: doc('current body'),
};

function renderEdit(over: Partial<DesignerProps> = {}) {
  return render(<Designer projectId={PROJECT} role="editor" pollMs={5} {...OPEN_DOCUMENT} {...over} />);
}

function enterEditMode() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit open document' }));
}

const EDIT_OPERATIONS: DocumentOperation[] = [
  { type: 'insert_section', ref: 'section-1', section: { kind: 'section' }, position: { mode: 'document_end' } },
  {
    type: 'insert_text',
    target: { mode: 'ref', ref: 'section-1', at: 'start' },
    block: { type: 'heading', level: 1, text: 'New heading' },
  },
];

/**
 * R5.5.2: a representable edit proposal carries document operations, so it can
 * be handed to the shared workspace mutation pipeline.
 */
function editProposal(text = 'Edited proposal body', baseRevision = REV): DesignerProposal {
  return {
    version: 1,
    baseRevision,
    document: doc(text),
    operations: { version: DOCUMENT_OPERATIONS_VERSION, baseRevision, operations: EDIT_OPERATIONS },
  };
}

/** A canonical-document-only proposal (the real writer/composer edit shape). */
function canonicalOnlyProposal(text = 'Edited proposal body', baseRevision = REV): DesignerProposal {
  return { version: 1, baseRevision, document: doc(text) };
}

function editRun(over: Partial<AgentRun> = {}): AgentRun {
  return run({
    input: { mode: 'intent', intent: { instruction: 'Improve it', projectId: PROJECT, contentId: CID } },
    ...over,
  });
}

interface EditApi {
  calls: Call[];
  setRun: (next: AgentRun) => void;
}

/** Transport fake for the edit flow: runs only (the apply is a workspace handoff). */
function editApi(initial: AgentRun): EditApi {
  let currentRun = initial;
  const calls: Call[] = [];
  apiMock.api.mockReset();
  apiMock.api.mockImplementation(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    if (method === 'POST' && path === RUNS_PATH) return { run: currentRun, reused: false };
    if (method === 'GET' && path.startsWith(`/projects/${PROJECT}/designer/runs/`)) return currentRun;
    throw new Error(`unexpected ${method} ${path}`);
  });
  return {
    calls,
    setRun: (next) => {
      currentRun = next;
    },
  };
}

async function startEditRun(instruction = 'Tighten the introduction') {
  fireEvent.change(screen.getByLabelText('How should the Designer change this document?'), {
    target: { value: instruction },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start design run' }));
}

describe('Designer edit + apply (shared workspace document)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMock.api.mockReset();
  });

  it('shows the open document and its live revision without listing or reading documents', () => {
    const fake = editApi(editRun({ status: 'queued' }));
    renderEdit();
    expect(screen.getByLabelText('What should the Designer create?')).toBeTruthy();

    enterEditMode();
    expect(screen.getByLabelText('How should the Designer change this document?')).toBeTruthy();
    expect(screen.getByText('Existing article')).toBeTruthy();
    expect(screen.getByText(REV)).toBeTruthy();

    // R5.5.1: identity/revision come from the shared workspace session, so the
    // Designer performs no /content list or detail read of its own.
    expect(fake.calls.some((c) => c.path === CONTENT_LIST_PATH)).toBe(false);
    expect(fake.calls.some((c) => c.path === CONTENT_DETAIL_PATH)).toBe(false);
  });

  it('submits an edit run with the open document id and no client base revision', async () => {
    const fake = editApi(editRun({ status: 'queued' }));
    renderEdit();
    enterEditMode();
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

  it('will not start an edit run when no document is open', () => {
    editApi(editRun({ status: 'queued' }));
    renderEdit({ documentId: null, documentTitle: null, documentRevision: null, documentStatus: 'idle' });
    enterEditMode();
    fireEvent.change(screen.getByLabelText('How should the Designer change this document?'), {
      target: { value: 'Tighten the introduction' },
    });

    expect((screen.getByRole('button', { name: 'Start design run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Open a document in the Editor before starting an edit run.')).toBeTruthy();
    expect(screen.getByText(/No document is open/)).toBeTruthy();
  });

  it('enters review for a succeeded edit run with the open document and proposal', async () => {
    editApi(editRun({ status: 'succeeded', result: editProposal() }));
    renderEdit({ onApplyProposal: vi.fn() });
    enterEditMode();
    await startEditRun();

    await screen.findByText('Edited proposal body');
    expect(screen.getByText('Proposed document')).toBeTruthy();
    expect(screen.getByText('Current document')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply to document' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.getAllByText(REV).length).toBeGreaterThan(0);
  });

  it('hands a representable proposal to the shared mutation pipeline instead of the legacy apply route', async () => {
    const onApplyProposal = vi.fn();
    const fake = editApi(editRun({ status: 'succeeded', result: editProposal() }));
    renderEdit({ onApplyProposal });
    enterEditMode();
    await startEditRun();
    await screen.findByText('Edited proposal body');

    fireEvent.click(screen.getByRole('button', { name: 'Apply to document' }));

    expect(onApplyProposal).toHaveBeenCalledTimes(1);
    const [handedProposal, targetId] = onApplyProposal.mock.calls[0]!;
    expect(targetId).toBe(CID);
    expect((handedProposal as DesignerProposal).baseRevision).toBe(REV);
    expect((handedProposal as DesignerProposal).operations).toBeTruthy();
    // R5.5.2: the workspace Designer never calls the legacy whole-document route.
    expect(pathsOf(fake.calls, 'POST').some((c) => c.path === APPLY_PATH)).toBe(false);
  });

  it('keeps a canonical-document-only proposal proposal-only and does not offer apply', async () => {
    const onApplyProposal = vi.fn();
    editApi(editRun({ status: 'succeeded', result: canonicalOnlyProposal() }));
    renderEdit({ onApplyProposal });
    enterEditMode();
    await startEditRun();
    await screen.findByText('Edited proposal body');

    expect(screen.getByText('This proposal cannot be applied from here.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply to document' })).toBeNull();
    // Reject stays available: the proposal is preserved for inspection.
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(onApplyProposal).not.toHaveBeenCalled();
  });

  it('disables apply when the live document no longer matches the proposal', async () => {
    const onApplyProposal = vi.fn();
    editApi(editRun({ status: 'succeeded', result: editProposal() }));
    renderEdit({ documentRevision: 'rev1:changed', onApplyProposal });
    enterEditMode();
    await startEditRun();
    await screen.findByText('Edited proposal body');

    expect(
      (screen.getByRole('button', { name: 'Apply to document' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/The open document no longer matches the revision/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply to document' }));
    expect(onApplyProposal).not.toHaveBeenCalled();
  });

  it('shows a proposal for another document as proposal-only, without apply', async () => {
    editApi(editRun({ status: 'succeeded', result: editProposal() }));
    renderEdit({ documentId: '99999999-9999-4999-8999-999999999999' });
    enterEditMode();
    await startEditRun();

    await screen.findByText('Edited proposal body');
    expect(screen.getByText(/generated for a different document/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply to document' })).toBeNull();
  });

  it('cannot hand off the same proposal twice', async () => {
    const onApplyProposal = vi.fn();
    editApi(editRun({ status: 'succeeded', result: editProposal() }));
    renderEdit({ onApplyProposal });
    enterEditMode();
    await startEditRun();
    await screen.findByText('Edited proposal body');

    const button = screen.getByRole('button', { name: 'Apply to document' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(onApplyProposal).toHaveBeenCalledTimes(1));
  });

  it('rejects a proposal without handing it off or writing content', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onApplyProposal = vi.fn();
    const fake = editApi(editRun({ status: 'succeeded', result: editProposal() }));
    renderEdit({ onApplyProposal });
    enterEditMode();
    await startEditRun();
    await screen.findByText('Edited proposal body');

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await screen.findByText('Proposal rejected. The saved document was not changed.');
    expect(confirmSpy).toHaveBeenCalled();
    expect(onApplyProposal).not.toHaveBeenCalled();
    expect(pathsOf(fake.calls, 'POST').some((c) => c.path === APPLY_PATH)).toBe(false);

    confirmSpy.mockRestore();
  });
});
