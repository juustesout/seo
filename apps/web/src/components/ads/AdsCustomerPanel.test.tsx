/**
 * AdsCustomerPanel tests (P5). The ads library is mocked so the component's
 * real useAsync runs while the API boundary is observable. Covers the
 * not-connected prompt, customer discovery/selection, the read-only viewer
 * state and honest error surfacing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdsCustomerPanel } from './AdsCustomerPanel';

const { adsMock } = vi.hoisted(() => ({
  adsMock: {
    connectAds: vi.fn(),
    projectAdsState: vi.fn(),
    projectAdsCustomers: vi.fn(),
    selectAdsCustomer: vi.fn(),
    clearAdsCustomer: vi.fn(),
  },
}));

vi.mock('../../lib/ads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/ads')>();
  return {
    ...actual,
    connectAds: (...args: unknown[]) => adsMock.connectAds(...args),
    projectAdsState: (...args: unknown[]) => adsMock.projectAdsState(...args),
    projectAdsCustomers: (...args: unknown[]) => adsMock.projectAdsCustomers(...args),
    selectAdsCustomer: (...args: unknown[]) => adsMock.selectAdsCustomer(...args),
    clearAdsCustomer: (...args: unknown[]) => adsMock.clearAdsCustomer(...args),
  };
});

const CONNECTED = {
  google: { connected: true, integration_id: 'int-ads', status: 'connected', account_email: 'user@example.com', error: null },
  current: null,
  can_manage: true,
};

const CUSTOMER = {
  customer_id: '111',
  name: 'Acme Ads',
  currency_code: 'USD',
  is_manager: false,
  login_customer_id: null,
  status: 'ENABLED',
};

beforeEach(() => {
  adsMock.connectAds.mockReset().mockResolvedValue(undefined);
  adsMock.projectAdsState.mockReset().mockResolvedValue(CONNECTED);
  adsMock.projectAdsCustomers.mockReset();
  adsMock.selectAdsCustomer.mockReset().mockResolvedValue({ customer: CUSTOMER });
  adsMock.clearAdsCustomer.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AdsCustomerPanel', () => {
  it('prompts to connect when Google Ads is not connected', async () => {
    adsMock.projectAdsState.mockResolvedValue({
      google: { connected: false, integration_id: null, status: null, account_email: null, error: null },
      current: null,
      can_manage: true,
    });
    render(<AdsCustomerPanel projectId="p1" role="admin" />);
    expect(await screen.findByText(/isn't connected/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /connect google ads/i })).toBeTruthy();
  });

  it('shows the connected identity and lets an admin select a discovered customer', async () => {
    adsMock.projectAdsCustomers.mockResolvedValue({
      google: CONNECTED.google,
      customers: [CUSTOMER, { ...CUSTOMER, customer_id: '222', name: 'Example Shop', currency_code: 'EUR' }],
    });
    render(<AdsCustomerPanel projectId="p1" role="admin" />);
    expect(await screen.findByText(/connected as user@example.com/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /choose customer/i }));
    expect(await screen.findByText('Acme Ads')).toBeTruthy();
    expect(screen.getByText('Example Shop')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Select' })[0]!);
    await waitFor(() => expect(adsMock.selectAdsCustomer).toHaveBeenCalledWith('p1', '111'));
  });

  it('shows the current customer to a viewer without management controls', async () => {
    adsMock.projectAdsState.mockResolvedValue({
      google: CONNECTED.google,
      current: CUSTOMER,
      can_manage: false,
    });
    render(<AdsCustomerPanel projectId="p1" role="viewer" />);
    expect(await screen.findByText('Acme Ads')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /choose customer/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /change/i })).toBeNull();
  });

  it('surfaces a discovery error without hiding the panel', async () => {
    adsMock.projectAdsCustomers.mockRejectedValue(new Error('This Google Ads customer is no longer accessible.'));
    render(<AdsCustomerPanel projectId="p1" role="admin" />);
    fireEvent.click(await screen.findByRole('button', { name: /choose customer/i }));
    expect(await screen.findByText(/no longer accessible/i)).toBeTruthy();
  });
});
