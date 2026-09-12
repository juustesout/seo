/**
 * KB7 freshness + refresh controls in the shared Source Detail surface.
 *
 * Verifies the derived freshness facts render for URL sources, that an editor
 * can refresh now / change the policy, that the honest outcome copy is shown
 * for unchanged vs changed vs failed refreshes, and that viewers get no write
 * controls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KnowledgeSourceDetailDto } from '@seo/contracts';
import { KnowledgeSourceDetail } from './KnowledgeSourceDetail';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../../lib/api', () => ({ api: apiMock.api }));

const PROJECT = 'p-1';
const SOURCE = 's-1';

function detail(overrides: Partial<KnowledgeSourceDetailDto> = {}): KnowledgeSourceDetailDto {
  return {
    id: SOURCE,
    project_id: PROJECT,
    source_type: 'url',
    name: 'Reference',
    url: 'https://example.com/a',
    status: 'ready',
    error: null,
    chunk_count: 3,
    last_indexed_at: '2026-01-05T00:00:00.000Z',
    original_filename: null,
    content_type: null,
    size_bytes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-04T00:00:00.000Z',
    preview: { text: 'preview body', truncated: false, characters: 12 },
    freshness: {
      state: 'fresh',
      refresh_policy: 'daily',
      last_fetched_at: '2026-01-02T03:04:00.000Z',
      last_changed_at: '2025-12-31T00:00:00.000Z',
      next_refresh_at: '2026-01-03T03:04:00.000Z',
      refresh_failures: 0,
    },
    ...overrides,
  };
}

const noop = () => undefined;

function renderDetail(props: Partial<Parameters<typeof KnowledgeSourceDetail>[0]> = {}) {
  return render(
    <KnowledgeSourceDetail
      projectId={PROJECT}
      detail={detail()}
      loading={false}
      error={null}
      canEdit
      busy={false}
      onClose={noop}
      onIngest={noop}
      onReindex={noop}
      onDelete={noop}
      {...props}
    />,
  );
}

function callsFor(suffix: string) {
  return apiMock.api.mock.calls.filter((c) => String(c[0]).endsWith(suffix));
}

beforeEach(() => {
  apiMock.api.mockReset();
});

describe('KnowledgeSourceDetail freshness facts (KB7)', () => {
  it('renders the derived state and the freshness facts for a URL source', () => {
    renderDetail();

    expect(screen.getByText('Fresh')).toBeTruthy();
    expect(screen.getByText('Last fetched')).toBeTruthy();
    expect(screen.getByText('Last changed')).toBeTruthy();
    expect(screen.getByText('Next check')).toBeTruthy();
    expect(screen.getByText('2026-01-02 03:04')).toBeTruthy();
    expect((screen.getByLabelText('Refresh policy') as HTMLSelectElement).value).toBe('daily');
  });

  it('hides the freshness block for a non-URL source', () => {
    renderDetail({ detail: detail({ source_type: 'text', url: null }) });

    expect(screen.queryByText('Freshness')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh now' })).toBeNull();
  });

  it('gives a viewer no refresh or policy controls', () => {
    renderDetail({ canEdit: false });

    expect(screen.queryByRole('button', { name: 'Refresh now' })).toBeNull();
    expect(screen.queryByLabelText('Refresh policy')).toBeNull();
  });
});

describe('KnowledgeSourceDetail refresh actions (KB7)', () => {
  it('refreshes, polls and reports an unchanged check honestly', async () => {
    apiMock.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { id: 'job-1' };
      return detail();
    });
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    expect(await screen.findByText('Checked successfully. No content changes.')).toBeTruthy();
    const post = callsFor(`/sources/${SOURCE}/refresh`)[0];
    expect(post?.[1]).toMatchObject({ method: 'POST' });
  });

  it('reports a changed body as updated and reindexed', async () => {
    const changed = detail({
      freshness: {
        state: 'fresh',
        refresh_policy: 'daily',
        last_fetched_at: '2026-02-01T00:00:00.000Z',
        last_changed_at: '2026-02-01T00:00:00.000Z',
        next_refresh_at: '2026-02-02T00:00:00.000Z',
        refresh_failures: 0,
      },
    });
    apiMock.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { id: 'job-1' };
      return changed;
    });
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    expect(await screen.findByText('Updated and reindexed.')).toBeTruthy();
  });

  it('keeps existing content and explains the bounded retry when a refresh fails', async () => {
    const failing = detail({
      error: 'knowledge_fetch_timeout',
      freshness: {
        state: 'fresh',
        refresh_policy: 'daily',
        last_fetched_at: '2026-01-02T03:04:00.000Z',
        last_changed_at: '2025-12-31T00:00:00.000Z',
        next_refresh_at: '2026-01-03T03:04:00.000Z',
        refresh_failures: 1,
      },
    });
    apiMock.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { id: 'job-1' };
      return failing;
    });
    renderDetail({ detail: failing });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    expect(await screen.findByText('Refresh failed. Existing indexed content is still available.')).toBeTruthy();
    expect(screen.getByText(/Next retry:/)).toBeTruthy();
  });

  it('persists a policy change through the PATCH endpoint', async () => {
    apiMock.api.mockResolvedValue({ source: detail() });
    renderDetail();

    fireEvent.change(screen.getByLabelText('Refresh policy'), { target: { value: 'weekly' } });

    await waitFor(() => expect(callsFor(`/sources/${SOURCE}`)).toHaveLength(1));
    const call = callsFor(`/sources/${SOURCE}`)[0];
    expect(call?.[1]).toMatchObject({ method: 'PATCH', body: { refresh_policy: 'weekly' } });
  });
});
