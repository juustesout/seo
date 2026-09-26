/**
 * R5.3 shell ownership: one `ProjectWorkspaceShell` owns one shared document
 * session for all three modes. Switching modes swaps only the active body; the
 * session boundary is not reset and the mode bodies never keep a second copy.
 *
 * The three mode bodies are mocked to lightweight probes that report the shared
 * workspace session they see, so the test isolates the shell's ownership from
 * the (already covered) editor internals.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectWorkspaceShell } from './ProjectWorkspaceShell';
import type { WorkspaceMode } from './WorkspaceModeSwitcher';

const probes = vi.hoisted(() => {
  const entries: Array<{ mode: string; session: unknown; boundary: string; contentId: string | null | undefined }> = [];
  return {
    entries,
    record(mode: string, session: unknown, boundary: string, contentId: string | null | undefined) {
      entries.push({ mode, session, boundary, contentId });
    },
    reset() {
      entries.length = 0;
    },
  };
});

vi.mock('../views/EditorView', async () => {
  const React = await import('react');
  const { useWorkspaceSessionContext } = await import('./workspaceSession');
  return {
    EditorView: ({ initialContentId }: { initialContentId?: string | null }) => {
      const ws = useWorkspaceSessionContext();
      React.useEffect(() => {
        probes.record('editor', ws.session, ws.session.boundary, initialContentId);
      }, []);
      return <div data-testid="mode-editor" />;
    },
  };
});

vi.mock('../views/Compose', async () => {
  const React = await import('react');
  const { useWorkspaceSessionContext } = await import('./workspaceSession');
  return {
    Compose: ({ onOpenEditor }: { onOpenEditor?: (id: string) => void }) => {
      const ws = useWorkspaceSessionContext();
      React.useEffect(() => {
        probes.record('composer', ws.session, ws.session.boundary, null);
      }, []);
      return (
        <button type="button" data-testid="mode-composer" onClick={() => onOpenEditor?.('draft-1')}>
          compose
        </button>
      );
    },
  };
});

vi.mock('../views/Designer', async () => {
  const React = await import('react');
  const { useWorkspaceSessionContext } = await import('./workspaceSession');
  return {
    Designer: () => {
      const ws = useWorkspaceSessionContext();
      React.useEffect(() => {
        probes.record('designer', ws.session, ws.session.boundary, null);
      }, []);
      return <div data-testid="mode-designer" />;
    },
  };
});

vi.mock('../lib/api', () => ({
  api: vi.fn(async (path: string) => {
    if (path.includes('/content?')) return { content: [], total: 0 };
    return {};
  }),
}));

afterEach(() => probes.reset());

describe('ProjectWorkspaceShell', () => {
  it('renders only the active mode and keeps one session across a mode switch', async () => {
    function Harness() {
      const [mode, setMode] = useState<WorkspaceMode>('editor');
      return <ProjectWorkspaceShell projectId="p1" role="owner" mode={mode} onModeChange={setMode} />;
    }
    render(<Harness />);
    await screen.findByTestId('mode-editor');
    expect(screen.queryByTestId('mode-designer')).toBeNull();
    await waitFor(() => expect(probes.entries.some((e) => e.mode === 'editor')).toBe(true));

    const boundaryBefore = probes.entries.at(-1)?.boundary;
    fireEvent.click(screen.getByTestId('workspace-mode-designer'));
    await screen.findByTestId('mode-designer');
    await waitFor(() => expect(probes.entries.some((e) => e.mode === 'designer')).toBe(true));

    expect(screen.queryByTestId('mode-editor')).toBeNull();
    const designer = probes.entries.at(-1);
    expect(designer?.mode).toBe('designer');
    // The shared session survives the mode switch: same boundary, one owner.
    expect(designer?.boundary).toBe(boundaryBefore);
    expect(probes.entries.filter((e) => e.mode === 'editor')).toHaveLength(1);
    expect(probes.entries.filter((e) => e.mode === 'designer')).toHaveLength(1);
  });

  it('opens a composer draft in the editor mode through the shared session', async () => {
    function Harness() {
      const [mode, setMode] = useState<WorkspaceMode>('composer');
      return <ProjectWorkspaceShell projectId="p1" role="owner" mode={mode} onModeChange={setMode} />;
    }
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('mode-composer'));
    await screen.findByTestId('mode-editor');
    await waitFor(() => expect(probes.entries.at(-1)?.mode).toBe('editor'));
    // The created draft becomes the one canonical active document; the editor
    // does not receive it through a shell-local id.
    expect(probes.entries.at(-1)?.session).toMatchObject({ identity: { documentId: 'draft-1' } });
  });

  it('keeps the switcher inert when the parent does not own the mode', async () => {
    render(<ProjectWorkspaceShell projectId="p1" role="owner" mode="editor" />);
    await screen.findByTestId('mode-editor');
    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    expect(screen.getByTestId('mode-editor')).toBeTruthy();
    expect(screen.queryByTestId('mode-composer')).toBeNull();
  });
});
