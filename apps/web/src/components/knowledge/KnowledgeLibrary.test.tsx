/**
 * Knowledge Library behaviour tests (KB5).
 *
 * Verifies the library surface end to end against a mocked transport: summary +
 * bounded list, type/status filtering and debounced metadata search, source
 * detail with a bounded preview, status-aware lifecycle actions, deliberate
 * delete confirmation, viewer read-only behaviour and loading/error states.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
    collection_id: null,
    collection_name: null,
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

/**
 * Route the mocked transport so the library's optional collections lookup
 * returns an empty list by default; the supplied handler answers everything
 * else. Keeps the source-focused tests independent of collection state.
 */
function mockApi(handler: (path: string, init?: { method?: string; body?: unknown }) => unknown) {
  apiMock.api.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (String(path).includes('/knowledge/collections')) return { items: [], total: 0, limit: 50, offset: 0 };
    return handler(path, init);
  });
}

beforeEach(() => {
  apiMock.api.mockReset();
  apiMock.apiRaw.mockReset();
});

describe('KnowledgeLibrary list + filters', () => {
  it('renders the summary and the bounded source list', async () => {
    mockApi(() =>
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
    mockApi(() =>response([source()]));
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    await screen.findByText('Reference');

    fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'file' } });

    await vi.waitFor(() => expect(paths().some((p) => p.includes('type=file'))).toBe(true));
  });

  it('searches source metadata after a short debounce', async () => {
    mockApi(() =>response([source()]));
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    await screen.findByText('Reference');

    fireEvent.change(screen.getByLabelText('Search sources'), { target: { value: 'alpha' } });

    await vi.waitFor(() => expect(paths().some((p) => p.includes('search=alpha'))).toBe(true), { timeout: 2000 });
  });

  it('shows an error banner when the list request fails', async () => {
    mockApi(() => { throw new Error('boom'); });
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    expect(await screen.findByText('boom')).toBeTruthy();
  });
});

describe('KnowledgeLibrary source detail', () => {
  it('opens a detail drawer with the bounded preview', async () => {
    mockApi(async (path: string) => {
      if (/\/sources\/s-1$/.test(String(path))) return detail();
      return response([source()]);
    });
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reference' }));

    expect(await screen.findByRole('dialog', { name: 'Source detail' })).toBeTruthy();
    expect(await screen.findByText('preview body')).toBeTruthy();
  });

  it('renders a safe sentence for a stored error code, never the raw code', async () => {
    mockApi(() =>response([source({ status: 'failed', error: 'knowledge_file_extract_failed' })]));
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    expect(await screen.findByText('The file could not be read. It may be corrupt or password-protected.')).toBeTruthy();
    expect(screen.queryByText('knowledge_file_extract_failed')).toBeNull();
  });
});

describe('KnowledgeLibrary lifecycle actions', () => {
  it('retries a failed source and reindexes a ready one', async () => {
    mockApi(async (_path: string, init?: { method?: string }) => {
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
    mockApi(async (_path: string, init?: { method?: string }) => {
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
    mockApi(() =>response([source()]));
    render(<KnowledgeLibrary projectId={PROJECT} canEdit={false} />);
    await screen.findByText('Reference');
    expect(screen.queryByRole('button', { name: 'Reindex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('KnowledgeLibrary collections (KB8)', () => {
  const COLLECTION = 'c-1';

  const collectionsResponse = {
    items: [
      {
        id: COLLECTION,
        projectId: PROJECT,
        name: 'References',
        description: null,
        sourceCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  };

  function withCollections(handler: (path: string, init?: { method?: string }) => unknown) {
    apiMock.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (String(path).includes('/knowledge/collections') && (!init?.method || init.method === 'GET')) {
        return collectionsResponse;
      }
      return handler(path, init);
    });
  }

  it('shows a collection badge on an assigned source', async () => {
    withCollections(() => response([source({ collection_id: COLLECTION, collection_name: 'References' })]));
    render(<KnowledgeLibrary projectId={PROJECT} canEdit={false} />);
    await screen.findByText('Reference');
    expect(screen.getByText('References')).toBeTruthy();
  });

  it('re-fetches with the collection and uncategorized filters', async () => {
    withCollections(() => response([source()]));
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    await screen.findByText('Reference');

    fireEvent.change(screen.getByLabelText('Filter by collection'), { target: { value: COLLECTION } });
    await vi.waitFor(() => expect(paths().some((p) => p.includes(`collection_id=${COLLECTION}`))).toBe(true));

    fireEvent.change(screen.getByLabelText('Filter by collection'), { target: { value: '__uncategorized__' } });
    await vi.waitFor(() => expect(paths().some((p) => p.includes('uncategorized=true'))).toBe(true));
  });

  it('bulk-moves selected sources into a collection', async () => {
    withCollections((path, init) => {
      if (init?.method === 'POST') return { updated: 2, collection_id: COLLECTION };
      return response([
        source({ id: 's-1', name: 'Alpha' }),
        source({ id: 's-2', name: 'Beta' }),
      ]);
    });
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByLabelText('Select Alpha'));
    fireEvent.click(screen.getByLabelText('Select Beta'));
    expect(screen.getByText('2 selected')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Move to collection'), { target: { value: COLLECTION } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    await vi.waitFor(() => {
      const call = apiMock.api.mock.calls.find((c) => String(c[0]).endsWith('/knowledge/sources/bulk'));
      expect(call).toBeTruthy();
      expect((call![1] as { body: unknown }).body).toEqual({ source_ids: ['s-1', 's-2'], collection_id: COLLECTION });
    });
  });

  it('lets an editor create a collection and reloads the list', async () => {
    const created = { ...collectionsResponse.items[0]!, id: 'c-2', name: 'New one' };
    withCollections((path, init) => {
      if (init?.method === 'POST') return { collection: created };
      return response([source()]);
    });
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    await screen.findByText('Reference');

    fireEvent.change(screen.getByLabelText('New collection name'), { target: { value: 'New one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create collection' }));

    await vi.waitFor(() => {
      const call = apiMock.api.mock.calls.find(
        (c) => String(c[0]).endsWith('/knowledge/collections') && (c[1] as { method?: string })?.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect((call![1] as { body: unknown }).body).toEqual({ name: 'New one', description: null });
    });
  });

  it('confirms a collection delete and tells the user sources are kept', async () => {
    withCollections((path, init) => {
      if (init?.method === 'DELETE') return { id: COLLECTION, deleted: true, sources_deleted: false };
      return response([source()]);
    });
    render(<KnowledgeLibrary projectId={PROJECT} canEdit />);
    await screen.findByText('Reference');

    const manager = within(screen.getByRole('group', { name: 'Collections' }));
    fireEvent.click(manager.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete collection? Sources are kept.')).toBeTruthy();

    fireEvent.click(manager.getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() =>
      expect(deleteCalls()).toContain(`/projects/${PROJECT}/knowledge/collections/${COLLECTION}`),
    );
  });
});
