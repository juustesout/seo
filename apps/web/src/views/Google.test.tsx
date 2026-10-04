/**
 * Unified Google hub tests (P6a + P8).
 *
 * The hub must state each product's state honestly from the three per-project
 * state payloads and route the user to the matching next action: open a
 * connected analysis, configure a connected-but-unbound product, or connect an
 * account when nothing is authorized yet. A failure loading one product must
 * not hide the other two.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Google } from './Google';

const { gscMock, analyticsMock, adsMock } = vi.hoisted(() => ({
  gscMock: vi.fn(),
  analyticsMock: vi.fn(),
  adsMock: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: null,
  configured: true,
  currentUser: vi.fn(async () => null),
  sessionToken: vi.fn(async () => null),
}));

vi.mock('../lib/gsc', () => ({
  connectGoogle: vi.fn(),
  projectGscState: gscMock,
}));

vi.mock('../lib/analytics', () => ({
  connectAnalytics: vi.fn(),
  projectAnalyticsState: analyticsMock,
}));

vi.mock('../lib/ads', () => ({
  connectAds: vi.fn(),
  projectAdsState: adsMock,
}));

const gscConnected = {
  google: { connected: true, error: null },
  current: { property_id: 'prop-1', site_url: 'https://example.com', is_primary: true },
  candidates: [],
};
const analyticsNotConnected = { google: { connected: false, error: null }, current: null, can_manage: false };
const adsNeedsConfig = { google: { connected: true, error: null }, current: null, can_manage: true };

beforeEach(() => {
  gscMock.mockReset();
  analyticsMock.mockReset();
  adsMock.mockReset();
  gscMock.mockResolvedValue(gscConnected);
  analyticsMock.mockResolvedValue(analyticsNotConnected);
  adsMock.mockResolvedValue(adsNeedsConfig);
});

describe('Google hub', () => {
  it('shows the derived state for each product', async () => {
    render(
      <Google projectId="p1" role="editor" onOpenSettings={() => {}} onOpenView={() => {}} />,
    );
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByText('Not configured for this project')).toBeTruthy();
  });

  it('opens the connected analysis', async () => {
    const onOpenView = vi.fn();
    render(<Google projectId="p1" role="editor" onOpenSettings={() => {}} onOpenView={onOpenView} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View search queries' }));
    expect(onOpenView).toHaveBeenCalledWith('keywords');
  });

  it('routes an unconfigured product to project settings', async () => {
    const onOpenSettings = vi.fn();
    render(<Google projectId="p1" role="editor" onOpenSettings={onOpenSettings} onOpenView={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('hides management actions from viewers', async () => {
    render(<Google projectId="p1" role="viewer" onOpenSettings={() => {}} onOpenView={() => {}} />);
    await screen.findByText('Not connected');
    expect(screen.queryByRole('button', { name: 'Connect Analytics' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull();
  });

  it('keeps the other products visible when one state fails to load', async () => {
    analyticsMock.mockRejectedValue(new Error('network down'));
    render(<Google projectId="p1" role="editor" onOpenSettings={() => {}} onOpenView={() => {}} />);

    expect(await screen.findByText('Could not load')).toBeTruthy();
    // Search Console still resolved and offers its action.
    expect(screen.getByRole('button', { name: 'View search queries' })).toBeTruthy();
    // Ads still shows its configure action.
    expect(screen.getByRole('button', { name: 'Configure' })).toBeTruthy();
  });
});
