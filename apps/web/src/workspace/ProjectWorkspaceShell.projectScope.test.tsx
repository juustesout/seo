/**
 * R5.9 project scope: the workspace is project-scoped. A different canonical
 * project id must remount the document session instead of reusing it, so Project
 * P's document, its document-scoped UI state and any pending edits can never leak
 * into Project Q. Route navigation crosses the same save barrier document
 * switching uses (R5.6).
 *
 * These tests use the real shell and editor mode so they exercise the actual
 * session registration, not a stand-in.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../lib/api';
import { runNavigationBarrier } from '../lib/navigationBarrier';
import { ProjectWorkspaceShell } from './ProjectWorkspaceShell';

const P1 = vi.hoisted(() => ({
  id: 'c1',
  title: 'Doc P1',
  slug: 'doc-p1',
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

const P2 = vi.hoisted(() => ({ ...P1, id: 'c2', title: 'Doc P2', slug: 'doc-p2' }));

vi.mock('../lib/api', async () => {
  const { tiptapEmptyDoc } = await import('@seo/contracts');
  const detail = (row: typeof P1) => ({ ...row, content_json: tiptapEmptyDoc(), content_html: '<p>hi</p>', outline: null });
  return {
    api: vi.fn(async (path: string) => {
      if (path.includes('/projects/p1/content?')) return { content: [P1], total: 1 };
      if (path.includes('/projects/p2/content?')) return { content: [P2], total: 1 };
      if (/\/projects\/p1\/content\/c1$/.test(path)) return detail(P1);
      if (/\/projects\/p2\/content\/c2$/.test(path)) return detail(P2);
      if (/\/ai$/.test(path)) return { configured: false };
      if (path.includes('/media')) return { media: [], note: null };
      if (path.includes('/jobs')) return [];
      if (path.includes('/publications') || path.includes('/schedules')) return [];
      return {};
    }),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

function Harness({ initial = 'p1' }: { initial?: string }) {
  const [projectId, setProjectId] = useState(initial);
  return (
    <div>
      <button type="button" onClick={() => setProjectId('p2')}>
        switch project
      </button>
      <ProjectWorkspaceShell projectId={projectId} role="owner" mode="editor" />
    </div>
  );
}

async function openDocument(title: string) {
  const cell = await screen.findByText(title);
  fireEvent.click(cell.closest('tr')!);
  await screen.findByTestId('document-header');
}

describe('R5.9 project-scoped workspace', () => {
  it('does not retain the previous project document when the project id changes', async () => {
    render(<Harness />);
    await openDocument('Doc P1');
    expect(screen.getByDisplayValue('Doc P1')).toBeTruthy();

    fireEvent.click(screen.getByText('switch project'));

    // Project Q mounts a fresh session: no document is open and its own list loads.
    await screen.findByText('Doc P2');
    expect(screen.queryByTestId('document-header')).toBeNull();
    expect(screen.queryByDisplayValue('Doc P1')).toBeNull();
    // Project P's document id is never requested under Project Q.
    expect(api).not.toHaveBeenCalledWith('/projects/p2/content/c1');
  });

  it('resets document-scoped workspace UI state across a project change', async () => {
    render(<Harness />);
    await openDocument('Doc P1');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByTestId('preview-pane')).toBeTruthy();

    fireEvent.click(screen.getByText('switch project'));
    await openDocument('Doc P2');

    // Preview is document-scoped, so Project Q starts from the default canvas.
    expect(screen.queryByTestId('preview-pane')).toBeNull();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
  });

  it('surfaces the canonical project context and routes to project admin', async () => {
    const onOpenSettings = vi.fn();
    const onOpenIntegrations = vi.fn();
    render(
      <ProjectWorkspaceShell
        projectId="p1"
        role="owner"
        mode="editor"
        project={{ name: 'Acme', websiteUrl: 'https://acme.test', connectedIntegrations: 2, totalIntegrations: 3 }}
        onOpenSettings={onOpenSettings}
        onOpenIntegrations={onOpenIntegrations}
      />,
    );
    await openDocument('Doc P1');

    expect(screen.getByTestId('workspace-project-settings').textContent).toContain('Acme');
    fireEvent.click(screen.getByTestId('workspace-project-settings'));
    fireEvent.click(screen.getByTestId('workspace-project-integrations'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenIntegrations).toHaveBeenCalledTimes(1);
  });

  it('flushes the open project document when route navigation crosses the barrier', async () => {
    render(<Harness />);
    await openDocument('Doc P1');
    fireEvent.change(screen.getByDisplayValue('Doc P1'), { target: { value: 'Doc P1 edited' } });

    await act(async () => {
      await expect(runNavigationBarrier()).resolves.toBe(true);
    });

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/projects/p1/content/c1', expect.objectContaining({ method: 'PATCH' })),
    );
  });
});
