/**
 * Plan view tests (P15 web).
 *
 * Covers the customer-facing plan surface: the account's effective plan card
 * and the public catalog with honest pricing (a decided free plan says so, a
 * draft price says it is undecided, never an invented number). The API module
 * is mocked; the shared `useAsync` hook runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AccountEntitlementDto, CustomerPlanDto } from '@seo/contracts';
import { Plan } from './Plan';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../lib/api', () => ({
  api: (...args: unknown[]) => apiMock.api(...args),
}));

const ENTITLEMENT: AccountEntitlementDto = {
  plan: {
    key: 'base',
    name: 'Base',
    displayName: 'Free',
    description: null,
    isDefault: true,
    isPublic: true,
    sortOrder: 0,
    pricing: { currency: null, monthlyPrice: 0, yearlyPrice: 0, priceStatus: 'final', priceLabel: 'Free' },
    billingIntervals: ['monthly', 'yearly'],
  },
  features: [{ feature: 'api_access', enabled: true }],
  allowances: [
    {
      resource: 'x_link_post',
      unit: 'link_posts',
      period: 'month',
      scope: 'account',
      operatorFunded: true,
      byokExempt: false,
      status: 'active',
      allowance: 10,
      consumed: 3,
      remaining: 7,
    },
  ],
  period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
};

const CATALOG: CustomerPlanDto[] = [
  {
    key: 'base',
    name: 'Base',
    displayName: 'Free',
    description: 'Free plan',
    isDefault: true,
    isPublic: true,
    sortOrder: 0,
    pricing: { currency: null, monthlyPrice: 0, yearlyPrice: 0, priceStatus: 'final', priceLabel: 'Free' },
    billingIntervals: ['monthly', 'yearly'],
    features: [{ feature: 'api_access', enabled: true }],
    allowances: [
      {
        resource: 'x_link_post',
        unit: 'link_posts',
        period: 'month',
        scope: 'account',
        operatorFunded: true,
        byokExempt: false,
        status: 'active',
        allowance: 10,
      },
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    displayName: 'Pro',
    description: null,
    isDefault: false,
    isPublic: true,
    sortOrder: 10,
    pricing: { currency: 'EUR', monthlyPrice: 1900, yearlyPrice: null, priceStatus: 'draft', priceLabel: null },
    billingIntervals: ['monthly'],
    features: [{ feature: 'api_access', enabled: true }],
    allowances: [
      {
        resource: 'ai_generation',
        unit: 'input_token',
        period: 'month',
        scope: 'account',
        operatorFunded: true,
        byokExempt: true,
        status: 'active',
        allowance: 0,
      },
    ],
  },
];

function mockApi(entitlement: unknown = ENTITLEMENT, catalog: unknown = CATALOG) {
  apiMock.api.mockImplementation((path: string) => {
    if (path === '/account/entitlement') return Promise.resolve(entitlement);
    if (path === '/plans') return Promise.resolve(catalog);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

beforeEach(() => {
  apiMock.api.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Plan view', () => {
  it('shows a loading state before the entitlement resolves', () => {
    apiMock.api.mockReturnValue(new Promise(() => {}));
    render(<Plan />);
    expect(screen.getByText('Loading plan…')).toBeTruthy();
  });

  it('renders the effective plan card with allowances', async () => {
    mockApi();
    render(<Plan />);
    expect(await screen.findByText('Plan & allowances')).toBeTruthy();
    expect(screen.getByText('3 / 10 used')).toBeTruthy();
    expect(apiMock.api).toHaveBeenCalledWith('/account/entitlement');
  });

  it('renders the public catalog with honest pricing', async () => {
    mockApi();
    render(<Plan />);
    expect(await screen.findByText('Available plans')).toBeTruthy();
    expect(await screen.findByText('Pro')).toBeTruthy();
    // A decided free plan says "Free"; a draft price is never invented.
    expect(screen.getAllByText('Free').length).toBeGreaterThan(0);
    expect(screen.getByText('Pricing to be confirmed')).toBeTruthy();
    expect(apiMock.api).toHaveBeenCalledWith('/plans');
  });

  it('states that pricing is informational and not a checkout', async () => {
    mockApi();
    render(<Plan />);
    expect(
      await screen.findByText(
        'Prices are shown for information only. This platform does not process payments or subscriptions.',
      ),
    ).toBeTruthy();
  });

  it('surfaces a catalog read failure instead of a fake catalog', async () => {
    apiMock.api.mockImplementation((path: string) => {
      if (path === '/account/entitlement') return Promise.resolve(ENTITLEMENT);
      return Promise.reject(new Error('catalog unavailable'));
    });
    render(<Plan />);
    expect(await screen.findByText('catalog unavailable')).toBeTruthy();
  });
});
