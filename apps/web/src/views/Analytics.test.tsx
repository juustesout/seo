/**
 * Analytics view tests (P4). pageTraffic is mocked so the real useAsync runs.
 * Covers the rendered table with large readable numbers, the honest empty
 * report, the no-property prompt and the error state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Analytics } from './Analytics';

const { pageTrafficMock } = vi.hoisted(() => ({ pageTrafficMock: vi.fn() }));

vi.mock('../lib/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/analytics')>();
  return { ...actual, pageTraffic: (...args: unknown[]) => pageTrafficMock(...args) };
});

const PROPERTY = { property_id: '111', property_name: 'My Website', property_url: 'https://example.com' };

beforeEach(() => {
  pageTrafficMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Analytics page-traffic view', () => {
  it('renders the page-traffic table with readable numbers', async () => {
    pageTrafficMock.mockResolvedValue({
      property: PROPERTY,
      period: { days: 28, start_date: '2026-09-02', end_date: '2026-09-29' },
      rows: [
        { path: '/', views: 4821, active_users: 3902, sessions: 4500 },
        { path: '/blog/seo-guide', views: 2184, active_users: 1731, sessions: 2000 },
      ],
      limit: 100,
      truncated: false,
    });
    render(<Analytics projectId="p1" />);
    expect(await screen.findByText('/blog/seo-guide')).toBeTruthy();
    expect(screen.getByText('4,821')).toBeTruthy();
    expect(screen.getByText('3,902')).toBeTruthy();
    expect(screen.getByText('My Website')).toBeTruthy();
  });

  it('shows an honest empty state when no traffic was recorded', async () => {
    pageTrafficMock.mockResolvedValue({
      property: PROPERTY,
      period: { days: 28, start_date: '2026-09-02', end_date: '2026-09-29' },
      rows: [],
      limit: 100,
      truncated: false,
    });
    render(<Analytics projectId="p1" />);
    expect(await screen.findByText(/no page traffic was recorded/i)).toBeTruthy();
  });

  it('prompts for a property when none is bound', async () => {
    pageTrafficMock.mockResolvedValue({
      property: null,
      period: { days: 28, start_date: '2026-09-02', end_date: '2026-09-29' },
      rows: [],
      limit: 100,
      truncated: false,
    });
    const onOpenSettings = vi.fn();
    render(<Analytics projectId="p1" onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText(/choose a google analytics property/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /open project settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('requests the selected period', async () => {
    pageTrafficMock.mockResolvedValue({
      property: PROPERTY,
      period: { days: 7, start_date: '2026-09-23', end_date: '2026-09-29' },
      rows: [],
      limit: 100,
      truncated: false,
    });
    render(<Analytics projectId="p1" />);
    await screen.findByText(/no page traffic was recorded/i);
    fireEvent.click(screen.getByRole('button', { name: /last 7 days/i }));
    await waitFor(() => expect(pageTrafficMock).toHaveBeenCalledWith('p1', 7));
  });

  it('surfaces an API error', async () => {
    pageTrafficMock.mockRejectedValue(new Error('Google Analytics authorization expired. Reconnect Google Analytics.'));
    render(<Analytics projectId="p1" />);
    expect(await screen.findByText(/authorization expired/i)).toBeTruthy();
  });
});
