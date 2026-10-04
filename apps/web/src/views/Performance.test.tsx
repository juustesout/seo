/**
 * Content performance view tests (P7 measurement loop). contentPerformance is
 * mocked so the real useAsync runs. Covers the joined table with honest totals,
 * the no-content empty state, provider notes, the sync action and role gating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Performance } from './Performance';

const { contentPerformanceMock, syncMock } = vi.hoisted(() => ({
  contentPerformanceMock: vi.fn(),
  syncMock: vi.fn(),
}));

vi.mock('../lib/performance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/performance')>();
  return {
    ...actual,
    contentPerformance: (...args: unknown[]) => contentPerformanceMock(...args),
    syncContentPerformance: (...args: unknown[]) => syncMock(...args),
  };
});

function report(overrides: Record<string, unknown> = {}) {
  return {
    project_id: 'p1',
    period: { days: 28, start_date: '2026-08-17', end_date: '2026-09-13' },
    sources: { gsc: true, ga4: true },
    rows: [],
    totals: { search: null, traffic: null },
    last_synced_at: null,
    notes: [],
    ...overrides,
  };
}

beforeEach(() => {
  contentPerformanceMock.mockReset();
  syncMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Content performance view', () => {
  it('renders published content with joined search and traffic metrics', async () => {
    contentPerformanceMock.mockResolvedValue(
      report({
        rows: [
          {
            content_id: 'c1',
            title: 'SEO Guide',
            content_status: 'published',
            target_keyword: 'seo guide',
            publication_url: 'https://example.com/blog/seo-guide',
            published_at: '2026-09-02T00:00:00Z',
            days_live: 11,
            matched_path: '/blog/seo-guide',
            search: { clicks: 150, impressions: 1500, ctr: 0.1, position: 5.67 },
            traffic: { views: 300, active_users: 250, sessions: 280 },
            state: 'measured',
          },
        ],
        totals: {
          search: { clicks: 150, impressions: 1500, ctr: 0.1, position: 5.67 },
          traffic: { views: 300, active_users: 250, sessions: 280 },
        },
        last_synced_at: '2026-09-12T00:00:00Z',
      }),
    );
    render(<Performance projectId="p1" role="editor" />);
    expect(await screen.findByText('SEO Guide')).toBeTruthy();
    expect(screen.getByText('Measured')).toBeTruthy();
    expect(screen.getAllByText('150').length).toBeGreaterThan(0);
    expect(screen.getAllByText('300').length).toBeGreaterThan(0);
  });

  it('shows an honest empty state when nothing is published', async () => {
    contentPerformanceMock.mockResolvedValue(report());
    render(<Performance projectId="p1" role="editor" />);
    expect(await screen.findByText(/no published content yet/i)).toBeTruthy();
  });

  it('shows provider notes when Google sources are not configured', async () => {
    contentPerformanceMock.mockResolvedValue(
      report({
        sources: { gsc: false, ga4: false },
        notes: [
          'Connect Search Console to see search performance for published content.',
          'Bind a Google Analytics property to see page traffic for published content.',
        ],
        rows: [
          {
            content_id: 'c1',
            title: 'SEO Guide',
            content_status: 'published',
            target_keyword: null,
            publication_url: null,
            published_at: null,
            days_live: null,
            matched_path: null,
            search: null,
            traffic: null,
            state: 'no_traffic',
          },
        ],
      }),
    );
    render(<Performance projectId="p1" role="editor" />);
    expect(await screen.findByText(/connect search console/i)).toBeTruthy();
    expect(screen.getByText('No traffic')).toBeTruthy();
  });

  it('labels not-configured and no-url rows distinctly', async () => {
    contentPerformanceMock.mockResolvedValue(
      report({
        sources: { gsc: false, ga4: false },
        rows: [
          {
            content_id: 'c1',
            title: 'Unconfigured',
            content_status: 'published',
            target_keyword: null,
            publication_url: null,
            published_at: null,
            days_live: null,
            matched_path: null,
            search: null,
            traffic: null,
            state: 'not_configured',
          },
          {
            content_id: 'c2',
            title: 'Untitled page',
            content_status: 'published',
            target_keyword: null,
            publication_url: null,
            published_at: null,
            days_live: null,
            matched_path: null,
            search: null,
            traffic: null,
            state: 'no_url',
          },
        ],
      }),
    );
    render(<Performance projectId="p1" role="editor" />);
    expect(await screen.findByText('Not configured')).toBeTruthy();
    expect(screen.getByText('No URL')).toBeTruthy();
  });

  it('starts a sync and reports the outcome', async () => {
    contentPerformanceMock.mockResolvedValue(report());
    syncMock.mockResolvedValue({
      jobs: [{ job_type: 'gsc_sync', job_id: 'j1' }],
      reused: false,
      skipped: [{ provider: 'ga4', reason: 'No Google Analytics property is bound to this project' }],
    });
    render(<Performance projectId="p1" role="editor" />);
    await screen.findByText(/no published content yet/i);
    fireEvent.click(screen.getByRole('button', { name: /sync data/i }));
    await waitFor(() => expect(syncMock).toHaveBeenCalledWith('p1', 28));
    expect(await screen.findByText(/1 sync job started/i)).toBeTruthy();
  });

  it('hides the sync action from viewers', async () => {
    contentPerformanceMock.mockResolvedValue(report());
    render(<Performance projectId="p1" role="viewer" />);
    await screen.findByText(/no published content yet/i);
    expect(screen.queryByRole('button', { name: /sync data/i })).toBeNull();
  });
});
