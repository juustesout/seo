/**
 * R5.3.2 integration: with a real editor mode body, the shell renders the
 * workspace chrome (document header, save indicator, assistant entry) once a
 * document is open, and drops it when the mode is no longer the editor.
 *
 * The mode bodies are real here (unlike `ProjectWorkspaceShell.test.tsx`, which
 * mocks them to probe session ownership), so this also covers the workspace
 * keymap that moved into the shell.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectWorkspaceShell } from './ProjectWorkspaceShell';
import type { WorkspaceMode } from './WorkspaceModeSwitcher';

const ROW = vi.hoisted(() => ({
  id: 'c1',
  title: 'Doc',
  slug: 'doc',
  status: 'draft',
  url: null,
  excerpt: null,
  target_keyword: null,
  seo_score: null,
  updated_at: '2026-01-01T00:00:00.000Z',
  published_at: null,
  meta_title: null,
  meta_description: null,
}));

vi.mock('../lib/api', async () => {
  const { tiptapEmptyDoc } = await import('@seo/contracts');
  return {
    api: vi.fn(async (path: string) => {
      if (path.includes('/content?')) return { content: [ROW], total: 1 };
      if (/\/content\/c1$/.test(path))
        return { ...ROW, content_json: tiptapEmptyDoc(), content_html: '<p>hi</p>', outline: null };
      if (/\/ai$/.test(path)) return { configured: false };
      if (path.includes('/jobs')) return [];
      if (path.includes('/publications') || path.includes('/schedules')) return [];
      return {};
    }),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

function Harness({ role = 'owner' }: { role?: string }) {
  const [mode, setMode] = useState<WorkspaceMode>('editor');
  return <ProjectWorkspaceShell projectId="p1" role={role} mode={mode} onModeChange={setMode} />;
}

async function openDocument() {
  const cell = await screen.findByText('Doc');
  fireEvent.click(cell.closest('tr')!);
  await screen.findByTestId('document-header');
}

describe('ProjectWorkspaceShell chrome integration', () => {
  it('renders the document header, save indicator and assistant entry for editor mode', async () => {
    render(<Harness />);
    await openDocument();
    expect(screen.getByTestId('document-save-state')).toBeTruthy();
    expect(screen.getByTestId('inline-assistant')).toBeTruthy();
    expect(screen.getByTestId('editor-workspace')).toBeTruthy();
  });

  it('keeps the shared document chrome in composer mode without editor canvas controls', async () => {
    render(<Harness />);
    await openDocument();
    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    expect(screen.getByTestId('document-header')).toBeTruthy();
    expect(screen.getByTestId('document-save-state')).toBeTruthy();
    // Insert/Preview act on the editor canvas, which is not mounted here.
    expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
    expect(screen.queryByTestId('editor-workspace')).toBeNull();
  });

  it('removes the chrome when the mode is designer', async () => {
    render(<Harness />);
    await openDocument();
    fireEvent.click(screen.getByTestId('workspace-mode-designer'));
    await waitFor(() => expect(screen.queryByTestId('document-header')).toBeNull());
    expect(screen.queryByTestId('inline-assistant')).toBeNull();
  });

  it('opens the assistant with Ctrl/Cmd+K and closes it with Escape', async () => {
    render(<Harness />);
    await openDocument();
    expect(screen.queryByTestId('embedded-agent-input')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(await screen.findByTestId('embedded-agent-input'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('embedded-agent-input')).toBeNull());
  });
});
