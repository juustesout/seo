/**
 * Knowledge Overview tests (KBUI1).
 *
 * The Overview is an operational landing page composed entirely from existing
 * read models. These tests verify the KPIs render from the API summary, the
 * health links carry the matching status filter to the Sources section, a
 * failed source deep-links to its detail, and an empty knowledge base gets the
 * honest "empty" call to action rather than invented metrics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { KnowledgeSourceDto, KnowledgeSourcesResponse } from '@seo/contracts';
import { KnowledgeOverview } from './KnowledgeOverview';

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

function response(items: KnowledgeSourceDto[], total = items.length): KnowledgeSourcesResponse {
  return {
    project_id: PROJECT,
    configured: true,
    provider: { id: 'qdrant', name: 'Qdrant', description: '', capabilities: [], kind: 'knowledge' },
    note: null,
    items,
    total,
    limit: 5,
    offset: 0,
    summary: {
      total,
      draft: 0,
      queued: 0,
      processing: 0,
      ready: items.filter((s) => s.status === 'ready').length,
      failed: items.filter((s) => s.status === 'failed').length,
      total_chunks: items.reduce((n, s) => n + s.chunk_count, 0),
    },
  };
}

beforeEach(() => {
  apiMock.api.mockReset();
  apiMock.apiRaw.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ data: [] }) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('KnowledgeOverview', () => {
  it('renders KPIs from the API summary and links the healthy state to a filtered Sources view', async () => {
    const onNavigate = vi.fn();
    apiMock.api.mockImplementation(async (path: string) => {
      if (String(path).includes('status=failed')) return response([source({ id: 's-9', name: 'Broken', status: 'failed' })]);
      return response([source()]);
    });

    render(<KnowledgeOverview projectId={PROJECT} canEdit collections={[]} onNavigate={onNavigate} />);

    expect(await screen.findByText('Total sources')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Healthy/ }));
    expect(onNavigate).toHaveBeenCalledWith('sources', { status: 'ready' });
  });

  it('deep-links a failed source to its detail drawer', async () => {
    const onNavigate = vi.fn();
    apiMock.api.mockImplementation(async (path: string) => {
      if (String(path).includes('status=failed')) return response([source({ id: 's-9', name: 'Broken', status: 'failed' })]);
      return response([source()]);
    });

    render(<KnowledgeOverview projectId={PROJECT} canEdit collections={[]} onNavigate={onNavigate} />);

    fireEvent.click(await screen.findByRole('button', { name: /Broken/ }));
    expect(onNavigate).toHaveBeenCalledWith('sources', { source: 's-9' });
  });

  it('shows the empty knowledge base call to action instead of fake metrics', async () => {
    apiMock.api.mockResolvedValue(response([], 0));

    render(<KnowledgeOverview projectId={PROJECT} canEdit collections={[]} onNavigate={() => {}} />);

    expect(await screen.findByText('Your knowledge base is empty')).toBeTruthy();
  });
});
