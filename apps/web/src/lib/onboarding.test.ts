import { describe, expect, it, vi } from 'vitest';
import { deriveOnboardingSteps, onboardingComplete } from './onboarding';

vi.mock('./supabase', () => ({
  supabase: null,
  configured: true,
  currentUser: vi.fn(async () => null),
  sessionToken: vi.fn(async () => null),
}));

describe('deriveOnboardingSteps', () => {
  it('marks every step not done for a brand-new project', () => {
    const steps = deriveOnboardingSteps({ googleConfigured: false, hasSearchData: false, hasContent: false });
    expect(steps.map((s) => s.id)).toEqual(['google', 'search', 'content']);
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(onboardingComplete(steps)).toBe(false);
  });

  it('completes steps independently from their signals', () => {
    const steps = deriveOnboardingSteps({ googleConfigured: true, hasSearchData: false, hasContent: true });
    expect(steps.find((s) => s.id === 'google')?.done).toBe(true);
    expect(steps.find((s) => s.id === 'search')?.done).toBe(false);
    expect(steps.find((s) => s.id === 'content')?.done).toBe(true);
    expect(onboardingComplete(steps)).toBe(false);
  });

  it('is complete once every step has a signal', () => {
    const steps = deriveOnboardingSteps({ googleConfigured: true, hasSearchData: true, hasContent: true });
    expect(onboardingComplete(steps)).toBe(true);
  });
});
