/**
 * Knowledge workspace shell tests (KBUI1).
 *
 * The workspace owns the four URL-driven sections. These tests verify the
 * shell renders the section navigation, exposes the shared read models to each
 * section, and routes a nav click through `onNavigate` (App maps that to a URL),
 * while each section composes the existing KB surfaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { KnowledgeSourceDto, KnowledgeSourcesResponse } from '@seo/contracts';
import { KnowledgeWorkspace } from './KnowledgeWorkspace';

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

function response(items: KnowledgeSourceDto[]): KnowledgeSourcesResponse {
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
      ready: items.length,
      failed: 0,
      total_chunks: items.reduce((n, s) => n + s.chunk_count, 0),
    },
  };
}

beforeEach(() => {
  apiMock.api.mockReset();
  apiMock.apiRaw.mockReset();
  apiMock.api.mockImplementation(async (path: string) => {
    const p = String(path);
    if (p.endsWith('/knowledge/status')) {
      return { project_id: PROJECT, provider: { id: 'qdrant', name: 'Qdrant', description: '' }, configured: true, note: null };
    }
    if (p.includes('/knowledge/collections')) return { items: [], total: 0, limit: 100, offset: 0 };
    if (p.includes('/knowledge/sources')) return response([source()]);
    return {};
  });
  // Overview composes useJobs, which polls /api/...; keep it off the network.
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ data: [] }) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('KnowledgeWorkspace', () => {
  it('renders the section navigation and the Overview landing page', async () => {
    render(<KnowledgeWorkspace projectId={PROJECT} role="owner" section="overview" search="" onNavigate={() => {}} />);

    const nav = screen.getByRole('navigation', { name: 'Knowledge sections' });
    expect(nav.textContent).toContain('Overview');
    expect(nav.textContent).toContain('Sources');
    expect(nav.textContent).toContain('Search');
    expect(nav.textContent).toContain('Discover');

    expect(screen.getByText('Knowledge Base')).toBeTruthy();
    expect(await screen.findByText('Total sources')).toBeTruthy();
  });

  it('routes a nav click through onNavigate', () => {
    const onNavigate = vi.fn();
    render(<KnowledgeWorkspace projectId={PROJECT} role="owner" section="overview" search="" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
    expect(onNavigate).toHaveBeenCalledWith('sources');
  });

  it('renders the Sources section with the Add source entry', async () => {
    render(<KnowledgeWorkspace projectId={PROJECT} role="owner" section="sources" search="" onNavigate={() => {}} />);

    await screen.findByText('Reference');
    expect(screen.getByRole('button', { name: '+ Add source' })).toBeTruthy();
  });

  it('renders the standalone Search section', () => {
    render(<KnowledgeWorkspace projectId={PROJECT} role="viewer" section="search" search="" onNavigate={() => {}} />);
    expect(screen.getByLabelText('Search query')).toBeTruthy();
  });

  it('renders the standalone Discover section', () => {
    render(<KnowledgeWorkspace projectId={PROJECT} role="owner" section="discover" search="" onNavigate={() => {}} />);
    expect(screen.getAllByText('Discover from website').length).toBeGreaterThan(0);
  });
});
