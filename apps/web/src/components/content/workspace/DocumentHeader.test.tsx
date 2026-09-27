import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DocumentHeader, SAVE_LABEL, type DocumentHeaderProps } from './DocumentHeader';

function makeProps(overrides: Partial<DocumentHeaderProps> = {}): DocumentHeaderProps {
  return {
    title: 'Title',
    onTitleChange: () => {},
    status: 'draft',
    onStatusChange: () => {},
    saveState: 'saved',
    wordCount: 12,
    slug: 'title',
    savedAt: null,
    canEdit: true,
    canDelete: true,
    busy: false,
    onSaveNow: () => {},
    onDelete: () => {},
    onBack: () => {},
    previewOpen: false,
    onTogglePreview: () => {},
    railOpen: false,
    onToggleRail: () => {},
    toolsOpen: false,
    onToggleTools: () => {},
    ...overrides,
  };
}

describe('DocumentHeader', () => {
  it('shows exactly one honest save indicator per state', () => {
    const { rerender } = render(<DocumentHeader {...makeProps({ saveState: 'unsaved' })} />);
    expect(screen.getByTestId('document-save-state').textContent).toContain(SAVE_LABEL.unsaved);
    rerender(<DocumentHeader {...makeProps({ saveState: 'saving' })} />);
    expect(screen.getByTestId('document-save-state').textContent).toContain(SAVE_LABEL.saving);
    rerender(<DocumentHeader {...makeProps({ saveState: 'failed' })} />);
    expect(screen.getByTestId('document-save-state').textContent).toContain(SAVE_LABEL.failed);
    expect(screen.getAllByTestId('document-save-state')).toHaveLength(1);
  });

  it('offers Publish until published, then hides it', () => {
    const { rerender } = render(<DocumentHeader {...makeProps({ status: 'draft' })} />);
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
    rerender(<DocumentHeader {...makeProps({ status: 'published' })} />);
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('toggles the on-demand tools rail from the canvas controls', () => {
    const onToggleTools = vi.fn();
    render(<DocumentHeader {...makeProps({ onToggleTools })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    expect(onToggleTools).toHaveBeenCalledTimes(1);
  });

  it('derives the canvas controls from the workspace surface (R5.8)', () => {
    const { rerender } = render(<DocumentHeader {...makeProps({ surface: 'canvas' })} />);
    expect(screen.getByRole('button', { name: 'Insert' })).toBeTruthy();

    // Preview is inspection-only: the editing Insert control is gone, Tools and
    // the Editing (back-to-editor) toggle remain.
    rerender(<DocumentHeader {...makeProps({ surface: 'preview', previewOpen: true })} />);
    expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Tools' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Editing' })).toBeTruthy();

    // Composer/Designer never mount the editor, so no canvas controls render.
    rerender(<DocumentHeader {...makeProps({ surface: 'designer' })} />);
    expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tools' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
  });

  it('shows the canonical project context and routes to project admin (R5.9)', () => {
    const onOpenSettings = vi.fn();
    const onOpenIntegrations = vi.fn();
    render(
      <DocumentHeader
        {...makeProps({
          project: { name: 'Acme', websiteUrl: 'https://acme.test', connectedIntegrations: 2, totalIntegrations: 3 },
          onOpenSettings,
          onOpenIntegrations,
        })}
      />,
    );

    // The user can see which project the document belongs to and reach admin.
    expect(screen.getByTestId('workspace-project-settings').textContent).toContain('Acme');
    expect(screen.getByTestId('workspace-project-integrations').textContent).toContain('2/3');
    fireEvent.click(screen.getByTestId('workspace-project-settings'));
    fireEvent.click(screen.getByTestId('workspace-project-integrations'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenIntegrations).toHaveBeenCalledTimes(1);
  });

  it('keeps secondary and destructive actions in the overflow menu', () => {
    const onViewPublications = vi.fn();
    const onOpenCalendar = vi.fn();
    const onDelete = vi.fn();
    render(<DocumentHeader {...makeProps({ onViewPublications, onOpenCalendar, onDelete })} />);
    fireEvent.click(screen.getByText('More'));
    fireEvent.click(screen.getByRole('button', { name: 'Publication history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Schedule calendar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete article' }));
    expect(onViewPublications).toHaveBeenCalledTimes(1);
    expect(onOpenCalendar).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
