/**
 * Knowledge Overview tests (KBUI3).
 *
 * The Overview is an operational dashboard composed entirely from existing read
 * models. These tests verify the health cards carry the matching status/freshness
 * filter to the Sources section, the attention queue deep-links a failed source,
 * processing is shown as its own section rather than as a problem, and an empty
 * knowledge base gets the honest "empty" call to action instead of invented
 * metrics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { KnowledgeSourceDto, KnowledgeSourceSummaryDto, KnowledgeSourcesResponse } from '@seo/contracts';
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

function response(items: KnowledgeSourceDto[], summary: Partial<KnowledgeSourceSummaryDto> = {}): KnowledgeSourcesResponse {
  return {
    project_id: PROJECT,
    configured: true,
    provider: { id: 'qdrant', name: 'Qdrant', description: '', capabilities: [], kind: 'knowledge' },
    note: null,
    items,
    total: summary.total ?? items.length,
    limit: 5,
    offset: 0,
    summary: {
      total: items.length,
      draft: 0,
      queued: 0,
      processing: 0,
      ready: 0,
      failed: 0,
      due: 0,
      stale: 0,
      total_chunks: 0,
      ...summary,
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
  it('renders health cards from the API summary and links Ready to a filtered Sources view', async () => {
    const onNavigate = vi.fn();
    apiMock.api.mockImplementation(async (path: string) => {
      if (String(path).includes('status=failed')) return response([], {});
      if (String(path).includes('freshness=')) return response([], {});
      if (String(path).includes('status=processing')) return response([], {});
      return response([source()], { total: 1, ready: 1 });
    });

    render(<KnowledgeOverview projectId={PROJECT} canEdit collections={[]} onNavigate={onNavigate} />);

    expect(await screen.findByText('Everything looks healthy.')).toBeTruthy();
    const health = screen.getByRole('region', { name: 'Knowledge health' });
    fireEvent.click(within(health).getByRole('button', { name: /Ready/ }));
    expect(onNavigate).toHaveBeenCalledWith('sources', { status: 'ready' });
  });

  it('deep-links a failed source to its detail from the attention queue', async () => {
    const onNavigate = vi.fn();
    apiMock.api.mockImplementation(async (path: string) => {
      if (String(path).includes('status=failed')) {
        return response([source({ id: 's-9', name: 'Broken', status: 'failed' })], { total: 1, failed: 1 });
      }
      if (String(path).includes('freshness=')) return response([], {});
      if (String(path).includes('status=processing')) return response([], {});
      return response([source({ id: 's-9', name: 'Broken', status: 'failed' })], { total: 1, failed: 1 });
    });

    render(<KnowledgeOverview projectId={PROJECT} canEdit collections={[]} onNavigate={onNavigate} />);

    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    fireEvent.click(within(attention).getByRole('button', { name: /Broken/ }));
    expect(onNavigate).toHaveBeenCalledWith('sources', { source: 's-9' });
  });

  it('shows processing as its own section, never as an attention problem', async () => {
    const onNavigate = vi.fn();
    apiMock.api.mockImplementation(async (path: string) => {
      if (String(path).includes('status=processing')) {
        return response([source({ id: 's-p', name: 'Crawling', status: 'processing' })], { total: 2, ready: 1, processing: 1 });
      }
      if (String(path).includes('status=failed')) return response([], {});
      if (String(path).includes('freshness=')) return response([], {});
      return response([source()], { total: 2, ready: 1, processing: 1 });
    });

    render(<KnowledgeOverview projectId={PROJECT} canEdit collections={[]} onNavigate={onNavigate} />);

    expect(await screen.findByText('1 source currently processing')).toBeTruthy();
    expect(screen.getByText('Nothing needs attention.')).toBeTruthy();
    expect(screen.queryByText('Everything looks healthy.')).toBeNull();
  });

  it('shows the empty knowledge base call to action instead of fake metrics', async () => {
    apiMock.api.mockResolvedValue(response([], { total: 0 }));

    render(<KnowledgeOverview projectId={PROJECT} canEdit collections={[]} onNavigate={() => {}} />);

    expect(await screen.findByText('Your knowledge base is empty')).toBeTruthy();
  });
});
