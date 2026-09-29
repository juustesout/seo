/**
 * AnalyticsPropertyPanel tests (P4). The analytics library is mocked so the
 * component's real useAsync runs while the API boundary is observable. Covers
 * the not-connected prompt, property discovery/selection, the read-only viewer
 * state and honest error surfacing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnalyticsPropertyPanel } from './AnalyticsPropertyPanel';

const { analyticsMock } = vi.hoisted(() => ({
  analyticsMock: {
    connectAnalytics: vi.fn(),
    projectAnalyticsState: vi.fn(),
    projectAnalyticsProperties: vi.fn(),
    selectAnalyticsProperty: vi.fn(),
    clearAnalyticsProperty: vi.fn(),
  },
}));

vi.mock('../../lib/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/analytics')>();
  return {
    ...actual,
    connectAnalytics: (...args: unknown[]) => analyticsMock.connectAnalytics(...args),
    projectAnalyticsState: (...args: unknown[]) => analyticsMock.projectAnalyticsState(...args),
    projectAnalyticsProperties: (...args: unknown[]) => analyticsMock.projectAnalyticsProperties(...args),
    selectAnalyticsProperty: (...args: unknown[]) => analyticsMock.selectAnalyticsProperty(...args),
    clearAnalyticsProperty: (...args: unknown[]) => analyticsMock.clearAnalyticsProperty(...args),
  };
});

const CONNECTED = {
  google: { connected: true, integration_id: 'int-ga4', status: 'connected', account_email: 'user@example.com', error: null },
  current: null,
  can_manage: true,
};

beforeEach(() => {
  analyticsMock.connectAnalytics.mockReset().mockResolvedValue(undefined);
  analyticsMock.projectAnalyticsState.mockReset().mockResolvedValue(CONNECTED);
  analyticsMock.projectAnalyticsProperties.mockReset();
  analyticsMock.selectAnalyticsProperty.mockReset().mockResolvedValue({ property: {} });
  analyticsMock.clearAnalyticsProperty.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AnalyticsPropertyPanel', () => {
  it('prompts to connect when Google Analytics is not connected', async () => {
    analyticsMock.projectAnalyticsState.mockResolvedValue({
      google: { connected: false, integration_id: null, status: null, account_email: null, error: null },
      current: null,
      can_manage: true,
    });
    render(<AnalyticsPropertyPanel projectId="p1" role="admin" />);
    expect(await screen.findByText(/isn't connected/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /connect google analytics/i })).toBeTruthy();
  });

  it('shows the connected identity and lets an admin select a discovered property', async () => {
    analyticsMock.projectAnalyticsProperties.mockResolvedValue({
      google: CONNECTED.google,
      properties: [
        { property_id: '111', property_name: 'My Website', property_url: 'https://example.com' },
        { property_id: '222', property_name: 'Example Shop', property_url: null },
      ],
    });
    render(<AnalyticsPropertyPanel projectId="p1" role="admin" />);
    expect(await screen.findByText(/connected as user@example.com/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /choose property/i }));
    expect(await screen.findByText('My Website')).toBeTruthy();
    expect(screen.getByText('Example Shop')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Select' })[0]!);
    await waitFor(() => expect(analyticsMock.selectAnalyticsProperty).toHaveBeenCalledWith('p1', '111'));
  });

  it('shows the current property to a viewer without management controls', async () => {
    analyticsMock.projectAnalyticsState.mockResolvedValue({
      google: CONNECTED.google,
      current: { property_id: '111', property_name: 'My Website', property_url: 'https://example.com' },
      can_manage: false,
    });
    render(<AnalyticsPropertyPanel projectId="p1" role="viewer" />);
    expect(await screen.findByText('My Website')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /choose property/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /change/i })).toBeNull();
  });

  it('surfaces a discovery error without hiding the panel', async () => {
    analyticsMock.projectAnalyticsProperties.mockRejectedValue(new Error('This Google Analytics property is no longer accessible.'));
    render(<AnalyticsPropertyPanel projectId="p1" role="admin" />);
    fireEvent.click(await screen.findByRole('button', { name: /choose property/i }));
    expect(await screen.findByText(/no longer accessible/i)).toBeTruthy();
  });
});
