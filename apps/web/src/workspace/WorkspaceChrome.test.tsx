/**
 * R5.3.2/R5.3.3: `WorkspaceChrome` owns the shared, workspace-level document
 * header (including its save indicator) and the save-failure status. It reads
 * the shared session and reports toggles upward; it owns no session state and no
 * editor-coupled chrome (the assistant entry lives in `EditorMode`).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { tiptapEmptyDoc } from '@seo/contracts';
import type { WorkspaceSessionValue } from './workspaceSession';
import { WorkspaceSessionProvider } from './workspaceSession';
import { WorkspaceChrome } from './WorkspaceChrome';

function makeSession(
  options: { saveStatus?: 'saved' | 'unsaved' | 'saving' | 'failed'; canEdit?: boolean; canDelete?: boolean } = {},
): WorkspaceSessionValue {
  const { saveStatus = 'saved', canEdit = true, canDelete = true } = options;
  const value = {
    projectId: 'p1',
    role: canEdit ? 'owner' : 'viewer',
    canEdit,
    canDelete,
    session: { identity: { documentId: 'c1', creating: false }, boundary: 'c1#0', hasDocument: true },
    auto: {
      status: saveStatus,
      dirty: saveStatus !== 'saved',
      setBaseline: vi.fn(),
      saveNow: vi.fn(),
      flush: vi.fn(async () => true),
    },
    doc: tiptapEmptyDoc(),
    title: 'My article',
    setTitle: vi.fn(),
    status: 'draft',
    changeStatus: vi.fn(),
    slug: 'my-article',
    savedAt: '2026-01-01T00:00:00.000Z',
    remove: vi.fn(async () => {}),
  };
  return value as unknown as WorkspaceSessionValue;
}

function renderChrome(session: WorkspaceSessionValue, props: Partial<React.ComponentProps<typeof WorkspaceChrome>> = {}) {
  const handlers = {
    onTogglePreview: vi.fn(),
    onToggleRail: vi.fn(),
    onBack: vi.fn(),
  };
  render(
    <WorkspaceSessionProvider value={session}>
      <WorkspaceChrome previewOpen={false} railOpen={false} {...handlers} {...props} />
    </WorkspaceSessionProvider>,
  );
  return handlers;
}

describe('WorkspaceChrome', () => {
  it('renders the document header with the authoritative save state', () => {
    renderChrome(makeSession({ saveStatus: 'saving' }));
    expect(screen.getByTestId('document-header')).toBeTruthy();
    expect(screen.getByTestId('document-save-state').textContent).toContain('Saving');
  });

  it('reports header actions and toggles to the shell', () => {
    const handlers = renderChrome(makeSession());
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect(handlers.onToggleRail).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(handlers.onTogglePreview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
  });

  it('renders no assistant entry (it is editor-mode-owned)', () => {
    renderChrome(makeSession());
    expect(screen.queryByTestId('inline-assistant')).toBeNull();
    expect(screen.queryByTestId('embedded-agent-open')).toBeNull();
  });

  it('surfaces save failure as workspace status', () => {
    renderChrome(makeSession({ saveStatus: 'failed' }));
    expect(screen.getByText(/Could not save your changes/)).toBeTruthy();
  });
});
