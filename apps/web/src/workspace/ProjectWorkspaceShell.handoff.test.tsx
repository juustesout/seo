/**
 * R5.4.2: the Composer draft-creation -> workspace-document handoff.
 *
 * The handoff is one explicit path through the canonical session: create the
 * draft, cross the existing save barrier with `requestDocumentSwitch`, and only
 * then enter the editor mode. The Composer surface is stubbed so the test
 * isolates the transition from the Composer engine; the autosave is stubbed so
 * the barrier result is controllable.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectWorkspaceShell } from './ProjectWorkspaceShell';
import type { WorkspaceMode } from './WorkspaceModeSwitcher';

const state = vi.hoisted(() => ({ flushOk: true }));
const probes = vi.hoisted(() => ({ editor: [] as Array<{ documentId: string | null; boundary: string }> }));

vi.mock('../components/content/useAutosave', () => ({
  useAutosave: () => ({
    status: 'saved',
    dirty: false,
    setBaseline: vi.fn(),
    saveNow: vi.fn(),
    flush: vi.fn(async () => state.flushOk),
  }),
}));

vi.mock('../views/EditorView', async () => {
  const React = await import('react');
  const { useWorkspaceSessionContext } = await import('./workspaceSession');
  return {
    EditorView: () => {
      const ws = useWorkspaceSessionContext();
      React.useEffect(() => {
        probes.editor.push({ documentId: ws.session.identity.documentId, boundary: ws.session.boundary });
      }, []);
      return <div data-testid="mode-editor">{ws.session.identity.documentId ?? ''}</div>;
    },
  };
});

vi.mock('../views/Compose', () => ({
  Compose: ({
    onOpenEditor,
    beginHandoff,
  }: {
    onOpenEditor: (id: string) => void;
    beginHandoff: () => { isStale: () => boolean };
  }) => (
    <button
      type="button"
      data-testid="compose-open"
      onClick={() => {
        const handoff = beginHandoff();
        if (!handoff.isStale()) onOpenEditor('draft-9');
      }}
    >
      open
    </button>
  ),
}));

vi.mock('../views/Designer', () => ({ Designer: () => <div data-testid="mode-designer" /> }));

vi.mock('../lib/api', () => ({
  api: vi.fn(async (path: string) => {
    if (path.includes('/content?')) return { content: [], total: 0 };
    if (path === '/projects/p1/content/draft-9') {
      return {
        id: 'draft-9',
        title: 'Draft',
        slug: 'draft',
        status: 'draft',
        content_json: { type: 'doc', content: [] },
        content_html: null,
        outline: null,
        target_keyword: null,
        meta_title: null,
        meta_description: null,
        url: null,
        excerpt: null,
        seo_score: null,
        updated_at: null,
        published_at: null,
      };
    }
    return {};
  }),
}));

afterEach(() => {
  state.flushOk = true;
  probes.editor.length = 0;
});

function Harness() {
  const [mode, setMode] = useState<WorkspaceMode>('composer');
  return <ProjectWorkspaceShell projectId="p1" role="owner" mode={mode} onModeChange={setMode} />;
}

describe('Composer document handoff', () => {
  it('mounts no editor infrastructure before the handoff', async () => {
    const { container } = render(<Harness />);
    await screen.findByTestId('compose-open');
    expect(screen.queryByTestId('mode-editor')).toBeNull();
    expect(screen.queryByTestId('editor-workspace')).toBeNull();
    expect(container.querySelector('.ProseMirror')).toBeNull();
  });

  it('makes the created draft the canonical session document, then opens the editor', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('compose-open'));

    await screen.findByTestId('mode-editor');
    // The editor mode is entered only after the switch, and it loads the
    // created document from the shared session, not from a Composer id.
    expect(screen.getByTestId('mode-editor').textContent).toBe('draft-9');
    expect(screen.queryByTestId('compose-open')).toBeNull();

    await waitFor(() => expect(probes.editor).toHaveLength(1));
    expect(probes.editor[0]?.documentId).toBe('draft-9');
    // A genuine document switch: the boundary advanced from the closed state.
    expect(probes.editor[0]?.boundary).not.toBe('closed#0');
  });

  it('keeps the current document and stays in Composer when the save barrier fails', async () => {
    state.flushOk = false;
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('compose-open'));

    await screen.findByText(/Could not switch documents/);
    expect(screen.queryByTestId('mode-editor')).toBeNull();
    expect(screen.getByTestId('compose-open')).toBeTruthy();
  });
});
