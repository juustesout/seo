/**
 * Onboarding checklist tests (P6a).
 *
 * Covers first-run, partially complete, fully complete and dismissed states,
 * plus that the dismiss action persists server-side (not only in the browser).
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FirstValueChecklist, OnboardingChecklist } from './OnboardingChecklist';
import { deriveOnboardingSteps } from '@/lib/onboarding';
import { projectGscState } from '@/lib/gsc';
import { projectAnalyticsState } from '@/lib/analytics';
import { projectAdsState } from '@/lib/ads';
import { api } from '@/lib/api';

vi.mock('@/lib/supabase', () => ({
  supabase: null,
  configured: true,
  currentUser: vi.fn(async () => null),
  sessionToken: vi.fn(async () => null),
}));
vi.mock('@/lib/gsc', () => ({ projectGscState: vi.fn(), connectGoogle: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ projectAnalyticsState: vi.fn(), connectAnalytics: vi.fn() }));
vi.mock('@/lib/ads', () => ({ projectAdsState: vi.fn(), connectAds: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: vi.fn() }));

const emptyGoogle = { google: { connected: false, error: null }, current: null };
const connectedGoogle = { google: { connected: true, error: null }, current: { id: 'x' } };

function setGoogle(state: unknown) {
  (projectGscState as Mock).mockResolvedValue(state);
  (projectAnalyticsState as Mock).mockResolvedValue(state);
  (projectAdsState as Mock).mockResolvedValue(state);
}

describe('FirstValueChecklist', () => {
  const steps = deriveOnboardingSteps({ googleConfigured: false, hasSearchData: false, hasContent: false });

  it('shows progress, action labels and reports the chosen target', () => {
    const onSelect = vi.fn();
    render(<FirstValueChecklist steps={steps} onSelect={onSelect} onDismiss={() => {}} />);
    expect(screen.getByText('Get started')).toBeTruthy();
    expect(screen.getByText('0 of 3 done. Follow these steps to get your first result.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Google' }));
    expect(onSelect).toHaveBeenCalledWith({ view: 'google' });
  });

  it('dismisses', () => {
    const onDismiss = vi.fn();
    render(<FirstValueChecklist steps={steps} onSelect={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss getting started' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('hides the action for completed steps', () => {
    const doneSteps = deriveOnboardingSteps({ googleConfigured: true, hasSearchData: false, hasContent: false });
    render(<FirstValueChecklist steps={doneSteps} onSelect={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Open Google' })).toBeNull();
    expect(screen.getByText('1 of 3 done. Follow these steps to get your first result.')).toBeTruthy();
  });
});

describe('OnboardingChecklist', () => {
  const base = {
    projectId: 'p1',
    role: 'editor',
    hasSearchData: false,
    dismissed: false,
    onDismissed: () => {},
    onOpenView: () => {},
  };

  it('is hidden for viewers', () => {
    setGoogle(emptyGoogle);
    (api as Mock).mockResolvedValue({ content: [], total: 0 });
    render(<OnboardingChecklist {...base} role="viewer" />);
    expect(screen.queryByText('Get started')).toBeNull();
  });

  it('is hidden once dismissed', () => {
    setGoogle(emptyGoogle);
    (api as Mock).mockResolvedValue({ content: [], total: 0 });
    render(<OnboardingChecklist {...base} dismissed />);
    expect(screen.queryByText('Get started')).toBeNull();
  });

  it('is hidden for an existing project that already has data', async () => {
    setGoogle(connectedGoogle);
    (api as Mock).mockResolvedValue({ content: [{ id: 'c1' }], total: 1 });
    render(<OnboardingChecklist {...base} hasSearchData />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(screen.queryByText('Get started')).toBeNull();
  });

  it('shows the first-run checklist for a brand-new project', async () => {
    setGoogle(emptyGoogle);
    (api as Mock).mockResolvedValue({ content: [], total: 0 });
    render(<OnboardingChecklist {...base} />);
    expect(await screen.findByText('Get started')).toBeTruthy();
    expect(screen.getByText('Connect Google data')).toBeTruthy();
  });

  it('persists dismissal through the API', async () => {
    setGoogle(emptyGoogle);
    (api as Mock).mockResolvedValue({ content: [], total: 0 });
    const onDismissed = vi.fn();
    render(<OnboardingChecklist {...base} onDismissed={onDismissed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss getting started' }));
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/projects/p1/onboarding/dismiss', { method: 'POST', body: {} });
  });
});
