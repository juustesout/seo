/**
 * Source Detail behaviour tests (KBUI2, extending the KB5/KB7 coverage).
 *
 * Verifies the composed detail experience: the operational sections, the
 * type-specific content preview (including the honest unavailable state), the
 * lifecycle stepper and lifecycle-aware actions, the failure explanation, the
 * KB7 freshness controls with honest outcome copy, collection reassignment and
 * the destructive delete confirmation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { KnowledgeSourceDetailDto } from '@seo/contracts';
import { SourceDetail } from './SourceDetail';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../../../lib/api', () => ({ api: apiMock.api }));

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
    collection_id: null,
    collection_name: null,
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

function renderDetail(props: Partial<Parameters<typeof SourceDetail>[0]> = {}) {
  return render(
    <SourceDetail
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

describe('SourceDetail structure', () => {
  it('composes the operational sections for a URL source', () => {
    renderDetail();

    for (const title of ['Overview', 'Content', 'Processing', 'Freshness', 'Activity', 'Actions']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    expect(screen.getAllByText('Fresh').length).toBeGreaterThan(0);
    expect(screen.getByText('preview body')).toBeTruthy();
    expect(screen.getAllByText('https://example.com/a').length).toBeGreaterThan(0);
  });

  it('shows each freshness fact once across the drawer', () => {
    renderDetail();
    expect(screen.getAllByText('Last fetched')).toHaveLength(1);
  });
});

describe('SourceDetail content preview (KBUI2)', () => {
  it('shows a text preview with a truncation indicator', () => {
    renderDetail({
      detail: detail({
        source_type: 'text',
        url: null,
        freshness: undefined,
        preview: { text: 'short', truncated: true, characters: 9000 },
      }),
    });

    expect(screen.getByText('short')).toBeTruthy();
    expect(screen.getByText(/Preview truncated/)).toBeTruthy();
  });

  it('explains that a file source has no preview instead of faking content', () => {
    renderDetail({
      detail: detail({
        source_type: 'file',
        url: null,
        freshness: undefined,
        original_filename: 'guide.pdf',
        content_type: 'application/pdf',
        size_bytes: 2048,
        preview: null,
      }),
    });

    expect(screen.getByText(/Preview unavailable for this source type/)).toBeTruthy();
    expect(screen.getByText('guide.pdf')).toBeTruthy();
  });

  it('is honest when a stored body is not available yet', () => {
    renderDetail({ detail: detail({ status: 'draft', preview: null }) });
    expect(screen.getByText(/No stored content to preview yet/)).toBeTruthy();
  });
});

describe('SourceDetail lifecycle actions (KBUI2)', () => {
  it('offers fetch-and-index for a draft URL and retries a failed source', () => {
    const onIngest = vi.fn();
    const { rerender } = renderDetail({
      detail: detail({ status: 'draft', freshness: undefined }),
      onIngest,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fetch and index' }));
    expect(onIngest).toHaveBeenCalledWith(SOURCE);

    rerender(
      <SourceDetail
        projectId={PROJECT}
        detail={detail({ status: 'failed', error: 'knowledge_fetch_timeout' })}
        loading={false}
        error={null}
        canEdit
        busy={false}
        onClose={noop}
        onIngest={onIngest}
        onReindex={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText('This source could not be processed.')).toBeTruthy();
    expect(screen.getByText('Fetching the page timed out. Try again later.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onIngest).toHaveBeenCalledWith(SOURCE);
  });

  it('reindexes a ready source and never offers a fetching action', () => {
    const onReindex = vi.fn();
    renderDetail({ onReindex });

    expect(screen.queryByRole('button', { name: 'Fetch and index' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
    expect(onReindex).toHaveBeenCalledWith(SOURCE);
  });

  it('reports processing without offering a conflicting action', () => {
    renderDetail({ detail: detail({ status: 'processing', preview: null }) });

    expect(screen.getByText('Processing this source…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reindex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows no lifecycle controls to a viewer', () => {
    renderDetail({ canEdit: false });
    expect(screen.queryByRole('button', { name: 'Reindex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('SourceDetail delete (KBUI2)', () => {
  it('confirms deletion in a dialog before calling onDelete', () => {
    const onDelete = vi.fn();
    renderDetail({ onDelete });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete "Reference"?')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Delete source' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(SOURCE);
  });

  it('warns that an uploaded document is removed with its content', () => {
    renderDetail({
      detail: detail({ source_type: 'file', url: null, freshness: undefined, original_filename: 'guide.pdf' }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/uploaded document and its indexed content will be removed/)).toBeTruthy();
  });
});

describe('SourceDetail collection (KBUI2)', () => {
  it('reassigns the collection through the existing PATCH endpoint', async () => {
    const onChanged = vi.fn();
    apiMock.api.mockResolvedValue({ source: detail() });
    renderDetail({
      onChanged,
      collections: [
        {
          id: 'c-1',
          projectId: PROJECT,
          name: 'References',
          description: null,
          sourceCount: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    fireEvent.change(screen.getByLabelText('Collection'), { target: { value: 'c-1' } });

    await waitFor(() => expect(callsFor(`/sources/${SOURCE}`)).toHaveLength(1));
    expect(callsFor(`/sources/${SOURCE}`)[0]?.[1]).toMatchObject({ method: 'PATCH', body: { collection_id: 'c-1' } });
  });
});

describe('SourceDetail freshness facts (KB7)', () => {
  it('renders the derived state and the freshness facts for a URL source', () => {
    renderDetail();

    expect(screen.getAllByText('Fresh').length).toBeGreaterThan(0);
    expect(screen.getByText('Last fetched')).toBeTruthy();
    expect(screen.getByText('Last changed')).toBeTruthy();
    expect(screen.getByText('Next check')).toBeTruthy();
    expect(screen.getByText('2026-01-02 03:04')).toBeTruthy();
    expect((screen.getByLabelText('Refresh policy') as HTMLSelectElement).value).toBe('daily');
  });

  it('hides the freshness block for a non-URL source', () => {
    renderDetail({ detail: detail({ source_type: 'text', url: null, freshness: undefined }) });

    expect(screen.queryByText('Freshness')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh now' })).toBeNull();
  });

  it('gives a viewer no refresh or policy controls', () => {
    renderDetail({ canEdit: false });

    expect(screen.queryByRole('button', { name: 'Refresh now' })).toBeNull();
    expect(screen.queryByLabelText('Refresh policy')).toBeNull();
  });
});

describe('SourceDetail refresh actions (KB7)', () => {
  it('refreshes, polls and reports an unchanged check honestly', async () => {
    apiMock.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { id: 'job-1' };
      return detail();
    });
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    expect(await screen.findByText('No changes detected. The existing index was kept.')).toBeTruthy();
    const post = callsFor(`/sources/${SOURCE}/refresh`)[0];
    expect(post?.[1]).toMatchObject({ method: 'POST' });
  });

  it('reports a changed body as reprocessed', async () => {
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
    apiMock.api.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { id: 'job-1' };
      return changed;
    });
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    expect(await screen.findByText('Changes detected. The source was reprocessed.')).toBeTruthy();
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
    apiMock.api.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { id: 'job-1' };
      return failing;
    });
    renderDetail({ detail: failing });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    expect(await screen.findByText('Refresh failed. Existing indexed content was preserved.')).toBeTruthy();
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
