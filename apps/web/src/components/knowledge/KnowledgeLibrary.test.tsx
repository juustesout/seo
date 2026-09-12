/**
 * Knowledge Library behaviour tests (KB5).
 *
 * Verifies the library surface end to end against a mocked transport: summary +
 * bounded list, type/status filtering and debounced metadata search, source
 * detail with a bounded preview, status-aware lifecycle actions, deliberate
 * delete confirmation, viewer read-only behaviour and loading/error states.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { KnowledgeSourceDetailDto, KnowledgeSourceDto, KnowledgeSourcesResponse } from '@seo/contracts';
import { KnowledgeLibrary } from './KnowledgeLibrary';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn(), apiRaw: vi.fn() } }));
vi.mock('../../lib/api', () => ({ api: apiMock.api, apiRaw: apiMock.apiRaw }));

const PROJECT = 'p-1';

function source(overrides: Partial<KnowledgeSourceDto> = {}): KnowledgeSourceDto {
  return {
    id: 's-1',
    project_id: PROJECT,
    source_type: 'text',
    name: 'Reference',
    url: null,
    status: 'ready',
    error: null,
    chunk_count: 2,
    last_indexed_at: '2026-01-02T00:00:00.000Z',
    original_filename: null,
    content_type: null,
    size_bytes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function response(items: KnowledgeSourceDto[], overrides: Partial<KnowledgeSourcesResponse> = {}): KnowledgeSourcesResponse {
  return {
    project_id: PROJECT,
    configured: true,
    provider: { id: 'qdrant', name: 'Qdrant', description: '', capabilities: [], kind: 'knowledge' },
    note: null,
    items,
    total: items.length,
    limit: 50,
    offset: 0,
    summary: {
      total: items.length,
      draft: 0,
      queued: 0,
      processing: 0,
      ready: items.filter((s) => s.status === 'ready').length,
      failed: items.filter((s) => s.status === 'failed').length,
      total_chunks: items.reduce((n, s) => n + s.chunk_count, 0),
    },
    ...overrides,
  };
}

function detail(overrides: Partial<KnowledgeSourceDetailDto> = {}): KnowledgeSourceDetailDto {
  return {
    ...source(),
    preview: { text: 'preview body', truncated: false, characters: 12 },
    ...overrides,
  };
}

function paths(): string[] {
  return apiMock.api.mock.calls.map((c) => String(c[0]));
}

function deleteCalls(): string[] {
  return apiMock.api.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'DELETE').map((c) => String(c[0]));
}

beforeEach(() => {
  apiMock.api.mockReset();
  apiMock.apiRaw.mockReset();
});

describe('KnowledgeLibrary list + filters', () => {
  it('renders the summary and the bounded source list', async () => {
    apiMock.api.mockResolvedValue(
      response([
        source({ name: 'Alpha guide', source_type: 'file', original_filename: 'a.pdf', content_type: 'application/pdf', size_bytes: 2048, chunk_count: 4 }),
        source({ id: 's-2', name: 'Beta', status: 'failed', chunk_count: 0 }),
      ]),
    );
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);

    expect(await screen.findByText('Alpha guide')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByLabelText('Knowledge summary')).toBeTruthy();
  });

  it('re-fetches with the type filter when it changes', async () => {
    apiMock.api.mockResolvedValue(response([source()]));
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    await screen.findByText('Reference');

    fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'file' } });

    await vi.waitFor(() => expect(paths().some((p) => p.includes('type=file'))).toBe(true));
  });

  it('searches source metadata after a short debounce', async () => {
    apiMock.api.mockResolvedValue(response([source()]));
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    await screen.findByText('Reference');

    fireEvent.change(screen.getByLabelText('Search sources'), { target: { value: 'alpha' } });

    await vi.waitFor(() => expect(paths().some((p) => p.includes('search=alpha'))).toBe(true), { timeout: 2000 });
  });

  it('shows an error banner when the list request fails', async () => {
    apiMock.api.mockRejectedValue(new Error('boom'));
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    expect(await screen.findByText('boom')).toBeTruthy();
  });
});

describe('KnowledgeLibrary source detail', () => {
  it('opens a detail drawer with the bounded preview', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      if (/\/sources\/s-1$/.test(String(path))) return detail();
      return response([source()]);
    });
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reference' }));

    expect(await screen.findByRole('dialog', { name: 'Source detail' })).toBeTruthy();
    expect(await screen.findByText('preview body')).toBeTruthy();
  });

  it('renders a safe sentence for a stored error code, never the raw code', async () => {
    apiMock.api.mockResolvedValue(response([source({ status: 'failed', error: 'knowledge_file_extract_failed' })]));
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    expect(await screen.findByText('The file could not be read. It may be corrupt or password-protected.')).toBeTruthy();
    expect(screen.queryByText('knowledge_file_extract_failed')).toBeNull();
  });
});

describe('KnowledgeLibrary lifecycle actions', () => {
  it('retries a failed source and reindexes a ready one', async () => {
    apiMock.api.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { job: { id: 'j' } };
      return response([
        source({ status: 'failed' }),
        source({ id: 's-2', name: 'Ready one', status: 'ready' }),
      ]);
    });
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(paths()).toContain(`/projects/${PROJECT}/knowledge/sources/s-1/ingest`));

    fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
    await vi.waitFor(() => expect(paths()).toContain(`/projects/${PROJECT}/knowledge/sources/s-2/reindex`));
  });

  it('requires confirmation before sending a delete', async () => {
    apiMock.api.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return { job: { id: 'j' } };
      return response([source()]);
    });
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    await screen.findByText('Reference');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete source?')).toBeTruthy();
    expect(deleteCalls()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(deleteCalls()).toContain(`/projects/${PROJECT}/knowledge/sources/s-1`));
  });

  it('hides lifecycle actions for a viewer', async () => {
    apiMock.api.mockResolvedValue(response([source()]));
    render(<KnowledgeLibrary projectId={PROJECT} canEdit={false} />);
    await screen.findByText('Reference');
    expect(screen.queryByRole('button', { name: 'Reindex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
