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
