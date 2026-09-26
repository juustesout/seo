/**
 * R5.3.3: editor infrastructure must be instantiated only by the editor mode.
 *
 * These tests use the real mode bodies and spy on the infrastructure
 * boundaries (Tiptap DOM, `EditorContextProvider`, `EditorSelectionProvider`,
 * the project AI request, the editor keymap) so Composer/Designer are proven
 * not to mount editor infrastructure, not merely to hide it.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../lib/api';
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

const mounts = vi.hoisted(() => ({ ctx: 0, sel: 0 }));

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

vi.mock('../components/content/editor/EditorContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/content/editor/EditorContext')>();
  const { jsx } = await import('react/jsx-runtime');
  return {
    ...actual,
    EditorContextProvider: (props: Parameters<typeof actual.EditorContextProvider>[0]) => {
      mounts.ctx += 1;
      return jsx(actual.EditorContextProvider, props);
    },
  };
});

vi.mock('../components/content/editor/EditorSelectionContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/content/editor/EditorSelectionContext')>();
  const { jsx } = await import('react/jsx-runtime');
  return {
    ...actual,
    EditorSelectionProvider: (props: Parameters<typeof actual.EditorSelectionProvider>[0]) => {
      mounts.sel += 1;
      return jsx(actual.EditorSelectionProvider, props);
    },
  };
});

afterEach(() => {
  mounts.ctx = 0;
  mounts.sel = 0;
  vi.clearAllMocks();
});

function Harness({ role = 'owner', initialMode = 'editor' }: { role?: string; initialMode?: WorkspaceMode }) {
  const [mode, setMode] = useState<WorkspaceMode>(initialMode);
  return <ProjectWorkspaceShell projectId="p1" role={role} mode={mode} onModeChange={setMode} />;
}

async function openDocument() {
  const cell = await screen.findByText('Doc');
  fireEvent.click(cell.closest('tr')!);
  await screen.findByTestId('document-header');
}

describe('workspace mode dispatch', () => {
  it('mounts the editor, and its infrastructure, for the editor mode', async () => {
    render(<Harness />);
    await openDocument();
    expect(screen.getByTestId('editor-workspace')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Compose' })).toBeNull();
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
    expect(mounts.ctx).toBeGreaterThan(0);
    expect(mounts.sel).toBeGreaterThan(0);
  });

  it('mounts only Compose for the composer mode, with no editor infrastructure', () => {
    render(<Harness initialMode="composer" />);
    expect(screen.getByRole('heading', { name: 'Compose' })).toBeTruthy();
    expect(screen.queryByTestId('editor-workspace')).toBeNull();
    expect(document.querySelector('.ProseMirror')).toBeNull();
    expect(mounts.ctx).toBe(0);
    expect(mounts.sel).toBe(0);
    expect(api).not.toHaveBeenCalledWith('/projects/p1/ai');
  });

  it('mounts only Designer for the designer mode, with no editor infrastructure', () => {
    render(<Harness initialMode="designer" />);
    expect(screen.queryByRole('heading', { name: 'Compose' })).toBeNull();
    expect(screen.queryByTestId('editor-workspace')).toBeNull();
    expect(document.querySelector('.ProseMirror')).toBeNull();
    expect(mounts.ctx).toBe(0);
    expect(mounts.sel).toBe(0);
    expect(api).not.toHaveBeenCalledWith('/projects/p1/ai');
  });

  it('does not register the editor keymap for Composer/Designer', () => {
    render(<Harness initialMode="composer" />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByTestId('embedded-agent-input')).toBeNull();
    fireEvent.click(screen.getByTestId('workspace-mode-designer'));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByTestId('embedded-agent-input')).toBeNull();
  });
});

describe('workspace mode switching', () => {
  it('removes editor infrastructure when leaving the editor mode', async () => {
    render(<Harness />);
    await openDocument();
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
    const ctxAfterOpen = mounts.ctx;
    const selAfterOpen = mounts.sel;

    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeNull());
    expect(screen.queryByTestId('editor-workspace')).toBeNull();
    // Leaving Editor does not mount another editor provider.
    expect(mounts.ctx).toBe(ctxAfterOpen);
    expect(mounts.sel).toBe(selAfterOpen);
  });

  it('does not instantiate editor infrastructure for composer -> designer', () => {
    render(<Harness initialMode="composer" />);
    fireEvent.click(screen.getByTestId('workspace-mode-designer'));
    expect(mounts.ctx).toBe(0);
    expect(mounts.sel).toBe(0);
    expect(document.querySelector('.ProseMirror')).toBeNull();
  });

  it('creates editor infrastructure when entering the editor mode', () => {
    render(<Harness initialMode="designer" />);
    expect(mounts.ctx).toBe(0);
    fireEvent.click(screen.getByTestId('workspace-mode-editor'));
    expect(mounts.ctx).toBeGreaterThan(0);
    expect(mounts.sel).toBeGreaterThan(0);
  });
});
