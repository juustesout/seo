/**
 * Knowledge Search Explorer behaviour tests (KB6).
 *
 * Verifies the retrieval surface end to end against a mocked transport:
 * canonical attributed results with bounded plain-text content and a score,
 * query/limit/type-filter pass-through, the empty state, the safe failure
 * sentence (no provider internals leak), plain-text-only (untrusted) rendering,
 * opening a managed hit in the shared KB5 Source Detail, and the read-only
 * behaviour when search is not configured.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { KnowledgeSearchHitDto, KnowledgeSearchResponse, KnowledgeSourceDetailDto } from '@seo/contracts';
import { KnowledgeSearchExplorer } from './KnowledgeSearchExplorer';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../../lib/api', () => ({ api: apiMock.api }));

const PROJECT = 'p-1';

function hit(overrides: Partial<KnowledgeSearchHitDto> = {}): KnowledgeSearchHitDto {
  return {
    source_id: 's-1',
    source_name: 'Alpha guide',
    source_type: 'text',
    source_url: null,
    managed: true,
    collection_id: null,
    collection_name: null,
    chunk_index: 0,
    content: 'the matched excerpt',
    score: 0.87,
    ...overrides,
  };
}

function searchResponse(results: KnowledgeSearchHitDto[], overrides: Partial<KnowledgeSearchResponse> = {}): KnowledgeSearchResponse {
  return {
    project_id: PROJECT,
    query: 'alpha',
    limit: 10,
    results,
    diagnostics: { result_count: results.length, provider: 'qdrant', search_duration_ms: 12 },
    ...overrides,
  };
}

function detail(): KnowledgeSourceDetailDto {
  return {
    id: 's-1',
    project_id: PROJECT,
    source_type: 'text',
    name: 'Alpha guide',
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
    preview: { text: 'preview body', truncated: false, characters: 12 },
  };
}

function searchCalls(): Array<{ path: string; body: Record<string, unknown> }> {
  return apiMock.api.mock.calls
    .filter((c) => String(c[0]).endsWith('/knowledge/search'))
    .map((c) => ({ path: String(c[0]), body: (c[1] as { body?: Record<string, unknown> } | undefined)?.body ?? {} }));
}

function firstSearchCall(): { path: string; body: Record<string, unknown> } {
  const call = searchCalls()[0];
  if (!call) throw new Error('expected a search call');
  return call;
}

function submit(query = 'alpha') {
  fireEvent.change(screen.getByLabelText('Search query'), { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

beforeEach(() => {
  apiMock.api.mockReset();
});

describe('KnowledgeSearchExplorer retrieval', () => {
  it('submits the query and renders attributed, scored, bounded results', async () => {
    apiMock.api.mockResolvedValue(searchResponse([hit()]));
    render(<KnowledgeSearchExplorer projectId={PROJECT} configured canEdit />);

    submit('alpha');

    expect(await screen.findByText('Alpha guide')).toBeTruthy();
    expect(screen.getByText('the matched excerpt')).toBeTruthy();
    expect(screen.getByText('score 0.870')).toBeTruthy();
    expect(screen.getByText('chunk 1')).toBeTruthy();
    await vi.waitFor(() => expect(searchCalls()).toHaveLength(1));
    const call = firstSearchCall();
    expect(call.path).toBe(`/projects/${PROJECT}/knowledge/search`);
    expect(call.body).toMatchObject({ query: 'alpha', limit: 10 });
    expect(call.body.source_types).toBeUndefined();
  });

  it('passes the selected limit and source-type filter through as allowlisted fields', async () => {
    apiMock.api.mockResolvedValue(searchResponse([hit({ source_type: 'file', managed: false })]));
    render(<KnowledgeSearchExplorer projectId={PROJECT} configured canEdit />);

    fireEvent.change(screen.getByLabelText('Result limit'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Filter by source type'), { target: { value: 'file' } });
    submit('alpha');

    await vi.waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(firstSearchCall().body).toMatchObject({ query: 'alpha', limit: 20, source_types: ['file'] });
  });

  it('trims the query before sending it', async () => {
    apiMock.api.mockResolvedValue(searchResponse([]));
    render(<KnowledgeSearchExplorer projectId={PROJECT} configured canEdit />);

    submit('  spaced  ');

    await vi.waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(firstSearchCall().body.query).toBe('spaced');
  });

  it('shows the empty state when there are no attributed results', async () => {
    apiMock.api.mockResolvedValue(searchResponse([]));
    render(<KnowledgeSearchExplorer projectId={PROJECT} configured canEdit />);

    submit('nothing');

    expect(await screen.findByText('No relevant knowledge found.')).toBeTruthy();
  });

  it('renders retrieved content as plain text, never as executed markup', async () => {
    const content = '<b>bold</b><script>alert(1)</script>';
    apiMock.api.mockResolvedValue(searchResponse([hit({ content })]));
    const { container } = render(<KnowledgeSearchExplorer projectId={PROJECT} configured canEdit />);

    submit('alpha');

    expect(await screen.findByText(content)).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('surfaces a safe failure sentence without leaking provider internals', async () => {
    apiMock.api.mockRejectedValue(new Error('Knowledge search is temporarily unavailable.'));
    render(<KnowledgeSearchExplorer projectId={PROJECT} configured canEdit />);

    submit('alpha');

    expect(await screen.findByText('Knowledge search is temporarily unavailable.')).toBeTruthy();
    expect(screen.queryByText(/qdrant\.internal|stack|api\.example/i)).toBeNull();
  });

  it('opens a managed hit in the shared Source Detail surface', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      if (String(path).endsWith('/knowledge/search')) return searchResponse([hit()]);
      return detail();
    });
    render(<KnowledgeSearchExplorer projectId={PROJECT} configured canEdit={false} />);

    submit('alpha');
    fireEvent.click(await screen.findByRole('button', { name: 'Open source' }));

    expect(await screen.findByRole('dialog', { name: 'Source detail' })).toBeTruthy();
    expect(await screen.findByText('preview body')).toBeTruthy();
    expect(apiMock.api).toHaveBeenCalledWith(`/projects/${PROJECT}/knowledge/sources/s-1`);
  });

  it('does not offer a Source Detail link for a system (unmanaged) hit', async () => {
    apiMock.api.mockResolvedValue(searchResponse([hit({ managed: false })]));
    render(<KnowledgeSearchExplorer projectId={PROJECT} configured canEdit />);

    submit('alpha');
    await screen.findByText('Alpha guide');

    expect(screen.queryByRole('button', { name: 'Open source' })).toBeNull();
  });
});

describe('KnowledgeSearchExplorer configuration', () => {
  it('disables search and explains when the provider is not configured', async () => {
    render(<KnowledgeSearchExplorer projectId={PROJECT} configured={false} canEdit />);

    expect(screen.getByText('Knowledge search is not usable on this server yet.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Search' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('KnowledgeSearchExplorer collections (KB8)', () => {
  const collectionsResponse = {
    items: [
      {
        id: 'c-1',
        projectId: PROJECT,
        name: 'References',
        description: null,
        sourceCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    total: 1,
    limit: 100,
    offset: 0,
  };

  function mockWithCollections(hits: KnowledgeSearchHitDto[]) {
    apiMock.api.mockImplementation(async (path: string) => {
      if (String(path).includes('/knowledge/collections')) return collectionsResponse;
      return searchResponse(hits);
    });
  }

  it('sends the collection filter and shows collection attribution on a hit', async () => {
    mockWithCollections([hit({ collection_id: 'c-1', collection_name: 'References' })]);
    render(<KnowledgeSearchExplorer projectId={PROJECT} configured canEdit />);

    await screen.findByRole('option', { name: 'References (1)' });
    fireEvent.change(screen.getByLabelText('Filter by collection'), { target: { value: 'c-1' } });
    submit('alpha');

    await vi.waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(firstSearchCall().body).toMatchObject({ query: 'alpha', collection_id: 'c-1' });
    expect(await screen.findByText('References')).toBeTruthy();
  });

  it('sends uncategorized=true when the uncategorized filter is chosen', async () => {
    mockWithCollections([hit()]);
    render(<KnowledgeSearchExplorer projectId={PROJECT} configured canEdit />);

    await screen.findByRole('option', { name: 'Uncategorized' });
    fireEvent.change(screen.getByLabelText('Filter by collection'), { target: { value: '__uncategorized__' } });
    submit('alpha');

    await vi.waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(firstSearchCall().body).toMatchObject({ query: 'alpha', uncategorized: true });
  });
});
