/**
 * R5.4.6: Composer as a native workspace mode.
 *
 * The workspace owns navigation and document identity; entering or leaving
 * Composer must only swap the active body, never create a second document
 * identity. This file pins those semantics with lightweight mode probes and a
 * Composer stub that can open/close a review, so the review navigation hold can
 * be exercised without the (already covered) Composer engine.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectWorkspaceShell } from './ProjectWorkspaceShell';
import type { WorkspaceMode } from './WorkspaceModeSwitcher';

const probes = vi.hoisted(() => ({ editor: [] as string[], designer: [] as string[] }));

vi.mock('../views/EditorView', async () => {
  const React = await import('react');
  const { useWorkspaceSessionContext } = await import('./workspaceSession');
  return {
    EditorView: () => {
      const ws = useWorkspaceSessionContext();
      React.useEffect(() => {
        probes.editor.push(ws.session.boundary);
      }, [ws.session.boundary]);
      return <div data-testid="mode-editor" data-boundary={ws.session.boundary} />;
    },
  };
});

vi.mock('../views/Compose', async () => {
  const { useWorkspaceSessionContext } = await import('./workspaceSession');
  return {
    Compose: ({
      onReviewOpenChange,
    }: {
      onReviewOpenChange?: (open: boolean) => void;
    }) => {
      const ws = useWorkspaceSessionContext();
      return (
        <div data-testid="mode-composer" data-boundary={ws.session.boundary}>
          <button type="button" data-testid="compose-review-open" onClick={() => onReviewOpenChange?.(true)}>
            open-review
          </button>
          <button type="button" data-testid="compose-review-close" onClick={() => onReviewOpenChange?.(false)}>
            close-review
          </button>
        </div>
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
        probes.designer.push(ws.session.boundary);
      }, [ws.session.boundary]);
      return <div data-testid="mode-designer" data-boundary={ws.session.boundary} />;
    },
  };
});

vi.mock('../lib/api', () => ({
  api: vi.fn(async (path: string) => {
    if (path.includes('/content?')) return { content: [], total: 0 };
    if (path.includes('/ai')) return { configured: false };
    if (path.includes('/jobs')) return [];
    return {};
  }),
}));

afterEach(() => {
  probes.editor.length = 0;
  probes.designer.length = 0;
  vi.clearAllMocks();
});

function Harness({ initialMode = 'editor' }: { initialMode?: WorkspaceMode }) {
  const [mode, setMode] = useState<WorkspaceMode>(initialMode);
  return <ProjectWorkspaceShell projectId="p1" role="owner" mode={mode} onModeChange={setMode} />;
}

describe('Composer workspace navigation', () => {
  it('reaches Composer from the canonical chrome without creating a document identity', async () => {
    render(<Harness initialMode="editor" />);
    const editor = await screen.findByTestId('mode-editor');
    const boundary = editor.getAttribute('data-boundary');

    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    const composer = await screen.findByTestId('mode-composer');
    expect(composer.getAttribute('data-boundary')).toBe(boundary);
    expect(screen.queryByTestId('mode-editor')).toBeNull();
  });

  it('returns to the editor through the existing navigation with the same identity', async () => {
    render(<Harness initialMode="composer" />);
    const composer = await screen.findByTestId('mode-composer');
    const boundary = composer.getAttribute('data-boundary');

    fireEvent.click(screen.getByTestId('workspace-mode-editor'));
    const editor = await screen.findByTestId('mode-editor');
    expect(editor.getAttribute('data-boundary')).toBe(boundary);
  });

  it('keeps one document identity across composer/designer/editor switches', async () => {
    render(<Harness initialMode="editor" />);
    const boundary = (await screen.findByTestId('mode-editor')).getAttribute('data-boundary');

    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    expect((await screen.findByTestId('mode-composer')).getAttribute('data-boundary')).toBe(boundary);

    fireEvent.click(screen.getByTestId('workspace-mode-designer'));
    expect((await screen.findByTestId('mode-designer')).getAttribute('data-boundary')).toBe(boundary);

    fireEvent.click(screen.getByTestId('workspace-mode-editor'));
    expect((await screen.findByTestId('mode-editor')).getAttribute('data-boundary')).toBe(boundary);

    // One identity: every mode body saw the same frozen boundary.
    expect(new Set([...probes.editor, ...probes.designer, boundary]).size).toBe(1);
  });

  it('refuses a mode switch while a review is open and allows it after cancel', async () => {
    render(<Harness initialMode="composer" />);
    await screen.findByTestId('mode-composer');

    fireEvent.click(screen.getByTestId('compose-review-open'));
    fireEvent.click(screen.getByTestId('workspace-mode-editor'));

    // Still in Composer, with the reason surfaced rather than silently dropped.
    expect(screen.getByTestId('mode-composer')).toBeTruthy();
    expect(screen.queryByTestId('mode-editor')).toBeNull();
    await screen.findByText(/Finish or cancel the composition review before leaving Composer/);

    fireEvent.click(screen.getByTestId('compose-review-close'));
    fireEvent.click(screen.getByTestId('workspace-mode-editor'));
    await screen.findByTestId('mode-editor');
  });
});
