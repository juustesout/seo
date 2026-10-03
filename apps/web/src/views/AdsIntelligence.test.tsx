/**
 * AdsIntelligence view tests (P5). adsReport is mocked so the real useAsync
 * runs. Covers the rendered search-term/keyword tables, the honest empty
 * report, the no-customer prompt, the period control, the text filter and the
 * error state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdsIntelligence } from './AdsIntelligence';

const { adsReportMock } = vi.hoisted(() => ({ adsReportMock: vi.fn() }));

vi.mock('../lib/ads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ads')>();
  return { ...actual, adsReport: (...args: unknown[]) => adsReportMock(...args) };
});

const CUSTOMER = { customer_id: '111', name: 'Acme Ads', currency_code: 'USD' };

const SEARCH_TERM = {
  search_term: 'seo tools',
  status: 'NONE',
  impressions: 4200,
  clicks: 210,
  cost: 152.5,
  conversions: 7,
  ctr: 0.05,
};

const KEYWORD = {
  keyword_text: 'seo software',
  match_type: 'PHRASE',
  status: 'ENABLED',
  campaign_name: 'Brand',
  ad_group_name: 'Search',
  impressions: 1000,
  clicks: 40,
  cost: 88,
  conversions: 2,
  ctr: 0.04,
};

function report(overrides: Record<string, unknown> = {}) {
  return {
    customer: CUSTOMER,
    period: { days: 28, start_date: '2026-09-02', end_date: '2026-09-29' },
    search_terms: [SEARCH_TERM],
    keywords: [KEYWORD],
    limit: 100,
    search_terms_truncated: false,
    keywords_truncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  adsReportMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AdsIntelligence paid search view', () => {
  it('renders the search-term and keyword tables with readable numbers', async () => {
    adsReportMock.mockResolvedValue(report());
    render(<AdsIntelligence projectId="p1" />);
    expect(await screen.findByText('seo tools')).toBeTruthy();
    expect(screen.getByText('seo software')).toBeTruthy();
    expect(screen.getByText('4,200')).toBeTruthy();
    expect(screen.getByText('USD 152.50')).toBeTruthy();
    expect(screen.getByText('5.00%')).toBeTruthy();
  });

  it('shows an honest empty state when no search terms were recorded', async () => {
    adsReportMock.mockResolvedValue(report({ search_terms: [], keywords: [] }));
    render(<AdsIntelligence projectId="p1" />);
    expect(await screen.findByText(/no search terms were recorded/i)).toBeTruthy();
    expect(screen.getByText(/no keywords were recorded/i)).toBeTruthy();
  });

  it('prompts for a customer when none is bound', async () => {
    adsReportMock.mockResolvedValue(report({ customer: null, search_terms: [], keywords: [] }));
    const onOpenSettings = vi.fn();
    render(<AdsIntelligence projectId="p1" onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText(/choose a google ads customer/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /open project settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('requests the selected period', async () => {
    adsReportMock.mockResolvedValue(report({ period: { days: 7, start_date: '2026-09-23', end_date: '2026-09-29' } }));
    render(<AdsIntelligence projectId="p1" />);
    await screen.findByText('seo tools');
    fireEvent.click(screen.getByRole('button', { name: /last 7 days/i }));
    await waitFor(() => expect(adsReportMock).toHaveBeenCalledWith('p1', 7, undefined));
  });

  it('applies a text filter on submit', async () => {
    adsReportMock.mockResolvedValue(report());
    render(<AdsIntelligence projectId="p1" />);
    await screen.findByText('seo tools');
    fireEvent.change(screen.getByPlaceholderText(/filter by text/i), { target: { value: 'shoes' } });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    await waitFor(() => expect(adsReportMock).toHaveBeenCalledWith('p1', 28, 'shoes'));
  });

  it('surfaces an API error', async () => {
    adsReportMock.mockRejectedValue(new Error('Google Ads authorization expired. Reconnect Google Ads.'));
    render(<AdsIntelligence projectId="p1" />);
    expect(await screen.findByText(/authorization expired/i)).toBeTruthy();
  });
});
