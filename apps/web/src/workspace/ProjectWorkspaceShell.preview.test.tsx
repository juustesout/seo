/**
 * R5.7 preview/responsive integration.
 *
 * The preview is an inspection surface for the current document revision. These
 * tests use the real editor mode body and the real shell so they exercise the
 * actual session, not a stand-in: previewing must not remount the editor, must
 * not persist anything, and a viewport change must only change the frame width.
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

const ROW2 = vi.hoisted(() => ({
  id: 'c2',
  title: 'Doc 2',
  slug: 'doc-2',
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
    api: vi.fn(async (path: string, options?: { method?: string }) => {
      if (path.includes('/content?')) return { content: [ROW, ROW2], total: 2 };
      if (/\/content\/c1$/.test(path) && options?.method !== 'PATCH')
        return { ...ROW, content_json: tiptapEmptyDoc(), content_html: '<p>hi</p>', outline: null };
      if (/\/content\/c2$/.test(path) && options?.method !== 'PATCH')
        return {
          ...ROW2,
          content_json: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Doc 2 body' }] }],
          },
          content_html: '<p>two</p>',
          outline: null,
        };
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

function Harness() {
  const [mode, setMode] = useState<WorkspaceMode>('editor');
  return <ProjectWorkspaceShell projectId="p1" role="owner" mode={mode} onModeChange={setMode} />;
}

async function openDocument(name = 'Doc') {
  const cell = await screen.findByText(name);
  fireEvent.click(cell.closest('tr')!);
  await screen.findByTestId('document-header');
  await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
}

function mutationCalls() {
  return vi.mocked(api).mock.calls.filter(([, options]) => Boolean(options?.method));
}

describe('R5.7 preview integration', () => {
  it('previews the current document without remounting the editor session', async () => {
    render(<Harness />);
    await openDocument();
    const editorNode = document.querySelector('.ProseMirror');

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByTestId('preview-pane')).toBeTruthy();
    expect(screen.getByTestId('preview-frame').getAttribute('sandbox')).toBe('');
    // The editor stays mounted and identical across preview/editor transitions.
    expect(document.querySelector('.ProseMirror')).toBe(editorNode);
    expect(screen.getByDisplayValue('Doc')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Editing' }));
    expect(screen.queryByTestId('preview-pane')).toBeNull();
    expect(document.querySelector('.ProseMirror')).toBe(editorNode);
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
  });

  it('changes only the preview viewport across desktop/tablet/mobile', async () => {
    render(<Harness />);
    await openDocument();
    const editorNode = document.querySelector('.ProseMirror');

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const frame = () => screen.getByTestId('preview-frame');
    expect(frame().getAttribute('data-width')).toBe('1280');

    fireEvent.click(screen.getByRole('button', { name: 'Tablet' }));
    expect(frame().getAttribute('data-viewport')).toBe('tablet');
    expect(frame().getAttribute('data-width')).toBe('834');

    fireEvent.click(screen.getByRole('button', { name: 'Mobile' }));
    expect(frame().getAttribute('data-width')).toBe('390');

    fireEvent.click(screen.getByRole('button', { name: 'Desktop' }));
    expect(frame().getAttribute('data-width')).toBe('1280');

    // Viewport is inspection-only: no document mutation, no remount, still saved.
    expect(mutationCalls()).toHaveLength(0);
    expect(document.querySelector('.ProseMirror')).toBe(editorNode);
    expect(screen.getByTestId('document-save-state').textContent).toContain('Saved');
  });

  it('resets preview state per document, so an old preview cannot touch the next document', async () => {
    render(<Harness />);
    await openDocument('Doc');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mobile' }));
    expect(screen.getByTestId('preview-frame').getAttribute('data-width')).toBe('390');
    const afterFirstPreview = mutationCalls().length;

    // Switch documents: the document-scoped preview state resets with the boundary.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await openDocument('Doc 2');
    expect(screen.queryByTestId('preview-pane')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const frame = screen.getByTestId('preview-frame');
    // Fresh default viewport, and the frame renders the newly opened document.
    expect(frame.getAttribute('data-viewport')).toBe('desktop');
    expect(frame.getAttribute('srcdoc')).toContain('Doc 2 body');
    // Switching and previewing persisted nothing.
    expect(mutationCalls().length).toBe(afterFirstPreview);
  });
});
