/**
 * Knowledge collection controls (KB8).
 *
 * Unit tests for the organization filter, the collection manager and the bulk
 * move bar. Collections are organizational metadata only: create/rename are
 * simple writes, delete is a two-step confirm that states sources are kept, and
 * the filter emits the mutually exclusive collection/uncategorized selection.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { KnowledgeCollectionDto } from '@seo/contracts';
import { KnowledgeBulkAssign, KnowledgeCollectionManager, KnowledgeOrganizationFilter, UNCATEGORIZED } from './KnowledgeCollections';

function collection(overrides: Partial<KnowledgeCollectionDto> = {}): KnowledgeCollectionDto {
  return {
    id: 'c-1',
    projectId: 'p-1',
    name: 'References',
    description: null,
    sourceCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('KnowledgeOrganizationFilter', () => {
  it('lists all sources, uncategorized and each collection with its count', () => {
    render(
      <KnowledgeOrganizationFilter
        collections={[collection({ name: 'Guides', sourceCount: 4 })]}
        value={{ collectionId: '', uncategorized: false }}
        onChange={() => undefined}
      />,
    );

    expect(screen.getByRole('option', { name: 'All sources' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Uncategorized' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Guides (4)' })).toBeTruthy();
  });

  it('emits the mutually exclusive selection for all / uncategorized / a collection', () => {
    const onChange = vi.fn();
    render(
      <KnowledgeOrganizationFilter
        collections={[collection()]}
        value={{ collectionId: '', uncategorized: false }}
        onChange={onChange}
      />,
    );

    const select = screen.getByLabelText('Filter by collection');
    fireEvent.change(select, { target: { value: UNCATEGORIZED } });
    expect(onChange).toHaveBeenLastCalledWith({ collectionId: '', uncategorized: true });

    fireEvent.change(select, { target: { value: 'c-1' } });
    expect(onChange).toHaveBeenLastCalledWith({ collectionId: 'c-1', uncategorized: false });

    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ collectionId: '', uncategorized: false });
  });
});

describe('KnowledgeCollectionManager', () => {
  it('creates a collection with a trimmed name and optional description', () => {
    const onCreate = vi.fn();
    render(
      <KnowledgeCollectionManager collections={[]} busy={false} onCreate={onCreate} onRename={() => undefined} onDelete={() => undefined} />,
    );

    fireEvent.change(screen.getByLabelText('New collection name'), { target: { value: '  SEO refs  ' } });
    fireEvent.change(screen.getByLabelText('New collection description'), { target: { value: '  team docs  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create collection' }));

    expect(onCreate).toHaveBeenCalledWith('SEO refs', 'team docs');
  });

  it('requires confirmation before deleting and states sources are kept', () => {
    const onDelete = vi.fn();
    render(
      <KnowledgeCollectionManager collections={[collection()]} busy={false} onCreate={() => undefined} onRename={() => undefined} onDelete={onDelete} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete collection? Sources are kept.')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith('c-1');
  });

  it('renames a collection inline', () => {
    const onRename = vi.fn();
    render(
      <KnowledgeCollectionManager collections={[collection()]} busy={false} onCreate={() => undefined} onRename={onRename} onDelete={() => undefined} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'Guides' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onRename).toHaveBeenCalledWith('c-1', 'Guides');
  });
});

describe('KnowledgeBulkAssign', () => {
  it('renders nothing without a selection', () => {
    const { container } = render(
      <KnowledgeBulkAssign collections={[collection()]} count={0} busy={false} onMove={() => undefined} onClear={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('moves the selection into a collection and out to uncategorized', () => {
    const onMove = vi.fn();
    render(
      <KnowledgeBulkAssign collections={[collection()]} count={2} busy={false} onMove={onMove} onClear={() => undefined} />,
    );

    const button = screen.getByRole('button', { name: 'Move' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Move to collection'), { target: { value: 'c-1' } });
    fireEvent.click(button);
    expect(onMove).toHaveBeenLastCalledWith('c-1');

    fireEvent.change(screen.getByLabelText('Move to collection'), { target: { value: UNCATEGORIZED } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(onMove).toHaveBeenLastCalledWith(null);
  });
});
