/**
 * KnowledgePanel behaviour tests (KB3 + KB4).
 *
 * Verifies the URL source lifecycle surface (draft URL offers Fetch, a
 * processing URL reads as "fetching", stored machine codes render as safe
 * sentences) and the KB4 file surface: a file is uploaded through the raw
 * transport and a stored file source shows its format and size. The transport
 * module is mocked; no live calls are made.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { KnowledgeSourceDto, KnowledgeSourcesResponse } from '@seo/contracts';
import { KnowledgePanel } from './KnowledgePanel';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn(), apiRaw: vi.fn() } }));
vi.mock('../../lib/api', () => ({ api: apiMock.api, apiRaw: apiMock.apiRaw }));

const PROJECT = 'p-1';

function response(sources: KnowledgeSourceDto[]): KnowledgeSourcesResponse {
  return {
    project_id: PROJECT,
    configured: true,
    provider: { id: 'qdrant', name: 'Qdrant', description: '', capabilities: [], kind: 'knowledge' },
    note: null,
    sources,
  };
}

function source(overrides: Partial<KnowledgeSourceDto>): KnowledgeSourceDto {
  return {
    id: 's-1',
    project_id: PROJECT,
    source_type: 'url',
    name: 'Reference',
    url: 'https://example.com/a',
    status: 'draft',
    error: null,
    chunk_count: 0,
    last_indexed_at: null,
    original_filename: null,
    content_type: null,
    size_bytes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.api.mockReset();
  apiMock.apiRaw.mockReset();
});

describe('KnowledgePanel URL sources', () => {
  it('offers Fetch on a draft URL and calls the ingest endpoint', async () => {
    apiMock.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { job: { id: 'job-1' } };
      return response([source({ status: 'draft' })]);
    });

    render(<KnowledgePanel projectId={PROJECT} canEdit />);

    const fetchButton = await screen.findByRole('button', { name: 'Fetch' });
    fireEvent.click(fetchButton);

    await vi.waitFor(() =>
      expect(apiMock.api).toHaveBeenCalledWith(`/projects/${PROJECT}/knowledge/sources/s-1/ingest`, {
        method: 'POST',
        body: {},
      }),
    );
  });

  it('shows a URL source mid-ingest as fetching', async () => {
    apiMock.api.mockResolvedValue(response([source({ status: 'processing' })]));
    render(<KnowledgePanel projectId={PROJECT} canEdit />);
    expect(await screen.findByText('fetching…')).toBeTruthy();
  });

  it('renders a stored error code as a safe sentence, never the raw code', async () => {
    apiMock.api.mockResolvedValue(response([source({ status: 'failed', error: 'knowledge_fetch_timeout' })]));
    render(<KnowledgePanel projectId={PROJECT} canEdit />);
    expect(await screen.findByText('Fetching the page timed out. Try again later.')).toBeTruthy();
    expect(screen.queryByText('knowledge_fetch_timeout')).toBeNull();
  });
});

describe('KnowledgePanel file sources', () => {
  it('uploads a selected file through the raw transport with its filename', async () => {
    apiMock.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { source: source({}) };
      return response([]);
    });
    apiMock.apiRaw.mockResolvedValue({ source: source({ source_type: 'file' }) });

    const { container } = render(<KnowledgePanel projectId={PROJECT} canEdit />);
    await screen.findByText(/No sources yet/i);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4 body'], 'guide.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    await vi.waitFor(() =>
      expect(apiMock.apiRaw).toHaveBeenCalledWith(
        `/projects/${PROJECT}/knowledge/sources/upload`,
        file,
        { filename: 'guide.pdf' },
      ),
    );
  });

  it('shows the format label and size for a stored file source', async () => {
    apiMock.api.mockResolvedValue(
      response([
        source({
          source_type: 'file',
          name: 'guide.pdf',
          url: null,
          original_filename: 'guide.pdf',
          content_type: 'application/pdf',
          size_bytes: 2048,
          status: 'ready',
        }),
      ]),
    );
    render(<KnowledgePanel projectId={PROJECT} canEdit />);
    expect(await screen.findByText(/PDF · 2\.0 KB/)).toBeTruthy();
    expect(screen.getByText('PDF · 2.0 KB')).toBeTruthy();
  });
});
