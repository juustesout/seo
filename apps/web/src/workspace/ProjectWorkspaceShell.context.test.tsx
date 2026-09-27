/**
 * R5.8 contextual UI integration.
 *
 * The workspace derives one context (mode + preview -> surface, plus the
 * canonical selection/viewport) and the chrome/rail follow it. These tests use
 * the real editor mode body and shell so they exercise the actual session:
 * preview is inspection-only, so the editing Insert control and the mutating
 * Media rail area disappear while inspection areas stay reachable.
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

function Harness() {
  const [mode, setMode] = useState<WorkspaceMode>('editor');
  return <ProjectWorkspaceShell projectId="p1" role="owner" mode={mode} onModeChange={setMode} />;
}

async function openDocument() {
  const cell = await screen.findByText('Doc');
  fireEvent.click(cell.closest('tr')!);
  await screen.findByTestId('document-header');
  await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
}

describe('R5.8 contextual workspace UI', () => {
  it('drops editing controls and the mutating Media area in preview, keeping inspection', async () => {
    render(<Harness />);
    await openDocument();

    // Editable canvas: Insert is available and the rail offers Media.
    expect(screen.getByRole('button', { name: 'Insert' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    expect(await screen.findByRole('tab', { name: 'Media' })).toBeTruthy();

    // Preview is inspection-only.
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByTestId('preview-pane')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Editing' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tools' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Media' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'SEO' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Insights' })).toBeTruthy();

    // Back on the canvas the editing surface is restored.
    fireEvent.click(screen.getByRole('button', { name: 'Editing' }));
    expect(screen.getByRole('button', { name: 'Insert' })).toBeTruthy();
    expect(await screen.findByRole('tab', { name: 'Media' })).toBeTruthy();
  });
});
