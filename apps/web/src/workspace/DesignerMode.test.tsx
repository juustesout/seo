/**
 * R5.5.1: `DesignerMode` is the architectural boundary between the shared
 * workspace session and the Designer surface.
 *
 * These tests pin the integration contract established in R5.5.1: project
 * identity, the open document and its live revision come from the shared
 * session (not from props or a Designer-local read), and the Designer performs
 * no `/content` list or detail fetch of its own. The boundary mounts no editor
 * infrastructure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { contentRevisionOf, tiptapEmptyDoc, type AgentRun } from '@seo/contracts';
import type { WorkspaceSessionValue } from './workspaceSession';
import { WorkspaceSessionProvider } from './workspaceSession';
import { DesignerMode } from './DesignerMode';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock.api };
});

const RUN: AgentRun = {
  runId: 'ar_boundary',
  kind: 'design',
  projectId: 'canon-1',
  status: 'queued',
  input: { mode: 'intent', intent: { instruction: 'Improve it', projectId: 'canon-1' } },
  result: null,
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
};

function sessionStub(over: { projectId?: string; documentId?: string | null } = {}): WorkspaceSessionValue {
  const { projectId = 'canon-1', documentId = 'doc-9' } = over;
  const doc = tiptapEmptyDoc();
  return {
    projectId,
    role: 'editor',
    doc,
    title: 'Open document',
    lifecycle: { status: 'ready', documentId, error: null },
    session: {
      identity: { documentId, creating: documentId === null },
      boundary: `${documentId ?? 'new'}#0`,
      hasDocument: documentId !== null,
    },
  } as unknown as WorkspaceSessionValue;
}

function renderDesigner(session: WorkspaceSessionValue) {
  return render(
    <WorkspaceSessionProvider value={session}>
      <DesignerMode />
    </WorkspaceSessionProvider>,
  );
}

describe('DesignerMode', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('binds the Designer to the shared open document and its live revision', () => {
    apiMock.api.mockReset();
    apiMock.api.mockReturnValue(new Promise(() => {}));
    const doc = tiptapEmptyDoc();
    renderDesigner(sessionStub());

    fireEvent.click(screen.getByRole('button', { name: 'Edit open document' }));
    expect(screen.getByText('Open document')).toBeTruthy();
    expect(screen.getByText(contentRevisionOf(doc))).toBeTruthy();
  });

  it('submits runs against the shared session project', async () => {
    apiMock.api.mockReset();
    apiMock.api.mockImplementation(async (path: string, opts: { method?: string } = {}) => {
      if ((opts.method ?? 'GET') === 'POST') return { run: { ...RUN, projectId: 'canon-42' }, reused: false };
      return RUN;
    });
    renderDesigner(sessionStub({ projectId: 'canon-42' }));

    fireEvent.change(screen.getByLabelText('What should the Designer create?'), {
      target: { value: 'Create a pricing page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start design run' }));

    await screen.findByText('Queued');
    expect(apiMock.api).toHaveBeenCalledWith(
      '/projects/canon-42/designer/runs',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('performs no content list or detail read of its own', () => {
    apiMock.api.mockReset();
    apiMock.api.mockReturnValue(new Promise(() => {}));
    renderDesigner(sessionStub());

    fireEvent.click(screen.getByRole('button', { name: 'Edit open document' }));

    const contentCalls = apiMock.api.mock.calls.filter(([path]) => String(path).includes('/content'));
    expect(contentCalls).toHaveLength(0);
  });

  it('mounts no editor infrastructure', () => {
    apiMock.api.mockReset();
    apiMock.api.mockReturnValue(new Promise(() => {}));
    const { container } = renderDesigner(sessionStub());

    expect(container.querySelector('.ProseMirror')).toBeNull();
    expect(screen.queryByTestId('editor-workspace')).toBeNull();
    expect(screen.queryByTestId('embedded-agent-open')).toBeNull();
  });
});
