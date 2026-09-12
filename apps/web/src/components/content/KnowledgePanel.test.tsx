/**
 * KnowledgePanel behaviour tests (KB3).
 *
 * Verifies the URL source lifecycle surface: a draft URL offers Fetch (which
 * calls the ingest endpoint), a processing URL reads as "fetching", and a
 * stored machine code renders as the shared safe sentence rather than a raw
 * provider error. The transport module is mocked; no live calls are made.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { KnowledgeSourceDto, KnowledgeSourcesResponse } from '@seo/contracts';
import { KnowledgePanel } from './KnowledgePanel';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../../lib/api', () => ({ api: apiMock.api }));

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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.api.mockReset();
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
