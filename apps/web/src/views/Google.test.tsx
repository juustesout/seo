/**
 * Unified Google hub tests (P6a).
 *
 * The hub must state each product's state honestly from the three per-project
 * state payloads and route the user to the matching next action: open a
 * connected analysis, configure a connected-but-unbound product, or connect an
 * account when nothing is authorized yet.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Google } from './Google';

vi.mock('../lib/supabase', () => ({
  supabase: null,
  configured: true,
  currentUser: vi.fn(async () => null),
  sessionToken: vi.fn(async () => null),
}));

vi.mock('../lib/gsc', () => ({
  connectGoogle: vi.fn(),
  projectGscState: vi.fn(async () => ({
    google: { connected: true, error: null },
    current: { property_id: 'prop-1', site_url: 'https://example.com', is_primary: true },
    candidates: [],
  })),
}));

vi.mock('../lib/analytics', () => ({
  connectAnalytics: vi.fn(),
  projectAnalyticsState: vi.fn(async () => ({
    google: { connected: false, error: null },
    current: null,
    can_manage: false,
  })),
}));

vi.mock('../lib/ads', () => ({
  connectAds: vi.fn(),
  projectAdsState: vi.fn(async () => ({
    google: { connected: true, error: null },
    current: null,
    can_manage: true,
  })),
}));

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
});
