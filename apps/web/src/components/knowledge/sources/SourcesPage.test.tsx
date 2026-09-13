/**
 * Knowledge Sources workspace behaviour tests (KB5/KB8/KBUI2).
 *
 * Verifies the Sources section end to end against a mocked transport: summary +
 * bounded list, filtering and debounced metadata search, distinct empty vs
 * filtered-empty vs load-failure states, the detail drawer (deep link, missing
 * source cleanup, safe error copy) and the lifecycle actions that now live in
 * the detail, plus the KB8 collection controls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type {
  KnowledgeCollectionDto,
  KnowledgeSourceDetailDto,
  KnowledgeSourceDto,
  KnowledgeSourcesResponse,
} from '@seo/contracts';
import { SourcesPage } from './SourcesPage';

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
      due: 0,
      stale: 0,
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

function mockApi(handler: (path: string, init?: { method?: string; body?: unknown }) => unknown) {
  apiMock.api.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => handler(String(path), init));
}

/** List requests end at `/knowledge/sources`; detail requests end with an id. */
function isDetail(path: string, id = 's-1'): boolean {
  return new RegExp(`/knowledge/sources/${id}$`).test(path);
}

function renderSources(props: Partial<Parameters<typeof SourcesPage>[0]> = {}) {
  return render(<SourcesPage projectId={PROJECT} canEdit configured {...props} />);
}

beforeEach(() => {
  apiMock.api.mockReset();
  apiMock.apiRaw.mockReset();
});

describe('SourcesPage list + filters', () => {
  it('renders the summary and the bounded source list', async () => {
    mockApi(() =>
      response([
        source({ name: 'Alpha guide', source_type: 'file', original_filename: 'a.pdf', content_type: 'application/pdf', size_bytes: 2048, chunk_count: 4 }),
        source({ id: 's-2', name: 'Beta', status: 'failed', chunk_count: 0 }),
      ]),
    );
    renderSources();

    expect(await screen.findByText('Alpha guide')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByLabelText('Knowledge summary')).toBeTruthy();
  });

  it('re-fetches with the type filter when it changes', async () => {
    mockApi(() => response([source()]));
    renderSources();
    await screen.findByText('Reference');

    fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'file' } });

    await vi.waitFor(() => expect(paths().some((p) => p.includes('type=file'))).toBe(true));
  });

  it('searches source metadata after a short debounce', async () => {
    mockApi(() => response([source()]));
    renderSources();
    await screen.findByText('Reference');

    fireEvent.change(screen.getByLabelText('Search sources'), { target: { value: 'alpha' } });

    await vi.waitFor(() => expect(paths().some((p) => p.includes('search=alpha'))).toBe(true), { timeout: 2000 });
  });

  it('honours an initial status filter passed by the Overview health links', async () => {
    mockApi(() => response([source({ status: 'failed' })]));
    renderSources({ initialStatus: 'failed' });
    await screen.findByText('Reference');

    expect(paths().some((p) => p.includes('status=failed'))).toBe(true);
  });
});

describe('SourcesPage empty states', () => {
  it('shows the empty knowledge base state with creation actions', async () => {
    mockApi(() => response([]));
    renderSources();

    expect(await screen.findByText('Your knowledge base is empty')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add source' })).toBeTruthy();
  });

  it('shows a distinct filtered-empty state with a clear-filters action', async () => {
    mockApi(() => response([], { summary: { total: 5, draft: 0, queued: 0, processing: 0, ready: 5, failed: 0, due: 0, stale: 0, total_chunks: 9 } }));
    renderSources();
    await screen.findByText('No sources match these filters.');

    fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'text' } });
    expect(await screen.findByText('No sources match these filters.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });

  it('shows a load-failure state and recovers on retry', async () => {
    let fail = true;
    mockApi(() => {
      if (fail) throw new Error('boom');
      return response([source()]);
    });
    renderSources();

    expect(await screen.findByText('boom')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Reference')).toBeTruthy();
  });
});

describe('SourcesPage source detail', () => {
  it('opens a detail drawer from a row and surfaces the deep link', async () => {
    const onQueryChange = vi.fn();
    mockApi((path) => (isDetail(path) ? detail() : response([source()])));
    renderSources({ onQueryChange });

    fireEvent.click(await screen.findByRole('button', { name: 'Reference' }));

    expect(await screen.findByRole('dialog', { name: 'Source detail' })).toBeTruthy();
    expect(await screen.findByText('preview body')).toBeTruthy();
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ source: 's-1' }));
  });

  it('deep-links straight to a source from the Overview', async () => {
    mockApi((path) => (isDetail(path) ? detail() : response([source()])));
    renderSources({ initialSourceId: 's-1' });

    expect(await screen.findByRole('dialog', { name: 'Source detail' })).toBeTruthy();
    expect(await screen.findByText('preview body')).toBeTruthy();
  });

  it('closes a missing deep-linked source and clears the query', async () => {
    const onQueryChange = vi.fn();
    apiMock.api.mockImplementation(async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    });
    renderSources({ initialSourceId: 'gone-1', onQueryChange });

    await vi.waitFor(() => expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ source: null })));
    expect(screen.queryByRole('dialog', { name: 'Source detail' })).toBeNull();
  });

  it('renders a safe sentence for a stored error code, never the raw code', async () => {
    mockApi((path) =>
      isDetail(path)
        ? detail({ status: 'failed', error: 'knowledge_file_extract_failed' })
        : response([source({ status: 'failed', error: 'knowledge_file_extract_failed' })]),
    );
    renderSources();

    fireEvent.click(await screen.findByRole('button', { name: 'Reference' }));
    expect(await screen.findByText('The file could not be read. It may be corrupt or password-protected.')).toBeTruthy();
    expect(screen.queryByText('knowledge_file_extract_failed')).toBeNull();
  });
});

describe('SourcesPage lifecycle actions (KBUI2, in the detail)', () => {
  it('retries a failed source and reindexes a ready one', async () => {
    mockApi((path, init) => {
      if (init?.method === 'POST') return { job: { id: 'j' } };
      if (isDetail(path, 's-1')) return detail({ status: 'failed', error: 'knowledge_fetch_timeout' });
      if (isDetail(path, 's-2')) return detail({ id: 's-2', name: 'Ready one', status: 'ready' });
      return response([
        source({ status: 'failed' }),
        source({ id: 's-2', name: 'Ready one', status: 'ready' }),
      ]);
    });
    renderSources();

    fireEvent.click(await screen.findByRole('button', { name: 'Reference' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(paths()).toContain(`/projects/${PROJECT}/knowledge/sources/s-1/ingest`));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ready one' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reindex' }));
    await vi.waitFor(() => expect(paths()).toContain(`/projects/${PROJECT}/knowledge/sources/s-2/reindex`));
  });

  it('requires confirmation before sending a delete', async () => {
    mockApi((path, init) => {
      if (init?.method === 'DELETE') return { job: { id: 'j' } };
      if (isDetail(path)) return detail();
      return response([source()]);
    });
    renderSources();
    fireEvent.click(await screen.findByRole('button', { name: 'Reference' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete "Reference"?')).toBeTruthy();
    expect(deleteCalls()).toEqual([]);

    const dialog = screen.getByRole('dialog', { name: 'Delete source' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(deleteCalls()).toContain(`/projects/${PROJECT}/knowledge/sources/s-1`));
  });

  it('hides lifecycle actions for a viewer', async () => {
    mockApi((path) => (isDetail(path) ? detail() : response([source()])));
    renderSources({ canEdit: false });

    fireEvent.click(await screen.findByRole('button', { name: 'Reference' }));
    expect(await screen.findByRole('dialog', { name: 'Source detail' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reindex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('SourcesPage collections (KB8)', () => {
  const COLLECTION = 'c-1';

  const collections: KnowledgeCollectionDto[] = [
    {
      id: COLLECTION,
      projectId: PROJECT,
      name: 'References',
      description: null,
      sourceCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  it('shows a collection badge on an assigned source', async () => {
    mockApi(() => response([source({ collection_id: COLLECTION, collection_name: 'References' })]));
    renderSources({ canEdit: false, collections });
    await screen.findByText('Reference');
    expect(screen.getByText('References')).toBeTruthy();
  });

  it('re-fetches with the collection and uncategorized filters', async () => {
    mockApi(() => response([source()]));
    renderSources({ collections });
    await screen.findByText('Reference');

    fireEvent.change(screen.getByLabelText('Filter by collection'), { target: { value: COLLECTION } });
    await vi.waitFor(() => expect(paths().some((p) => p.includes(`collection_id=${COLLECTION}`))).toBe(true));

    fireEvent.change(screen.getByLabelText('Filter by collection'), { target: { value: '__uncategorized__' } });
    await vi.waitFor(() => expect(paths().some((p) => p.includes('uncategorized=true'))).toBe(true));
  });

  it('bulk-moves selected sources into a collection', async () => {
    mockApi((_path, init) => {
      if (init?.method === 'POST') return { updated: 2, collection_id: COLLECTION };
      return response([
        source({ id: 's-1', name: 'Alpha' }),
        source({ id: 's-2', name: 'Beta' }),
      ]);
    });
    renderSources({ collections });
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

  it('lets an editor create a collection', async () => {
    mockApi((_path, init) => {
      if (init?.method === 'POST') return { collection: { ...collections[0]!, id: 'c-2', name: 'New one' } };
      return response([source()]);
    });
    renderSources({ collections });
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
    mockApi((_path, init) => {
      if (init?.method === 'DELETE') return { id: COLLECTION, deleted: true, sources_deleted: false };
      return response([source()]);
    });
    renderSources({ collections });
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
