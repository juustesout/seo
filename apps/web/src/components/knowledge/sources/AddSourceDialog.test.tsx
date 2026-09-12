/**
 * Add Source flow tests (KBUI1).
 *
 * The dialog must present one deliberate choice at a time (Text / Website /
 * File), show only the matching form, and report the honest lifecycle: a source
 * is created immediately while indexing is queued in the background. These
 * tests assert the requests the flow composes from the existing endpoints.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { KnowledgeSourceDto } from '@seo/contracts';
import { AddSourceDialog } from './AddSourceDialog';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn(), apiRaw: vi.fn() } }));
vi.mock('../../../lib/api', () => ({ api: apiMock.api, apiRaw: apiMock.apiRaw }));

const PROJECT = 'p-1';

function source(overrides: Partial<KnowledgeSourceDto> = {}): KnowledgeSourceDto {
  return {
    id: 's-1',
    project_id: PROJECT,
    source_type: 'text',
    name: 'Reference',
    url: null,
    status: 'draft',
    error: null,
    chunk_count: 0,
    last_indexed_at: null,
    original_filename: null,
    content_type: null,
    size_bytes: null,
    collection_id: null,
    collection_name: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function paths(): string[] {
  return apiMock.api.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  apiMock.api.mockReset();
  apiMock.apiRaw.mockReset();
});

describe('AddSourceDialog', () => {
  it('asks what to add before showing any form', () => {
    render(<AddSourceDialog projectId={PROJECT} open onClose={() => {}} onCreated={() => {}} />);

    expect(screen.getByText('What would you like to add?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Text/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Website \/ URL/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /File/ })).toBeTruthy();
    expect(screen.queryByLabelText('Content')).toBeNull();
  });

  it('shows only the file form after choosing File', () => {
    render(<AddSourceDialog projectId={PROJECT} open onClose={() => {}} onCreated={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /File/ }));

    expect(screen.getByText(/Adding File/)).toBeTruthy();
    expect(screen.queryByLabelText('Content')).toBeNull();
    expect(screen.queryByLabelText('Web page URL')).toBeNull();
  });

  it('creates a text source and reports the queued lifecycle', async () => {
    const onCreated = vi.fn();
    apiMock.api.mockResolvedValue({ source: source() });
    render(<AddSourceDialog projectId={PROJECT} open onClose={() => {}} onCreated={onCreated} />);

    fireEvent.click(screen.getByRole('button', { name: /Text/ }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Notes' } });
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'some content' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Knowledge Base' }));

    expect(await screen.findByText('Source added')).toBeTruthy();
    expect(onCreated).toHaveBeenCalledWith('s-1', 'text');
    const call = apiMock.api.mock.calls.find((c) => String(c[0]).endsWith('/knowledge/sources'));
    expect((call![1] as { body: unknown }).body).toEqual({ name: 'Notes', source_type: 'text', text: 'some content' });
  });

  it('creates a URL source and queues ingestion', async () => {
    apiMock.api.mockResolvedValue({ source: source({ source_type: 'url' }) });
    render(<AddSourceDialog projectId={PROJECT} open onClose={() => {}} onCreated={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Website \/ URL/ }));
    fireEvent.change(screen.getByLabelText('Web page URL'), { target: { value: 'https://example.com/docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fetch & index' }));

    expect(await screen.findByText('Fetching and indexing…')).toBeTruthy();
    expect(paths()).toContain(`/projects/${PROJECT}/knowledge/sources/s-1/ingest`);
  });

  it('uploads a file through the raw transport and queues ingestion', async () => {
    apiMock.api.mockResolvedValue({ source: source({ source_type: 'file' }) });
    apiMock.apiRaw.mockResolvedValue({ source: source({ source_type: 'file' }) });
    render(<AddSourceDialog projectId={PROJECT} open onClose={() => {}} onCreated={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /File/ }));
    const file = new File(['hello'], 'guide.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload & index' }));

    expect(await screen.findByText('Uploading and indexing…')).toBeTruthy();
    expect(apiMock.apiRaw).toHaveBeenCalledWith(
      `/projects/${PROJECT}/knowledge/sources/upload`,
      file,
      { filename: 'guide.pdf' },
    );
    expect(paths()).toContain(`/projects/${PROJECT}/knowledge/sources/s-1/ingest`);
  });
});
