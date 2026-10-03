/**
 * First-value onboarding model (P6a).
 *
 * A brand-new project gets a short, dismissible checklist whose steps are
 * derived from real project state (never fake sample data): connect a Google
 * data source, read search/keyword insight, then create the first content. The
 * same functions drive the UI and are unit-tested in isolation.
 */
import { api } from './api';

export interface OnboardingSignals {
  googleConfigured: boolean;
  hasSearchData: boolean;
  hasContent: boolean;
}

export interface OnboardingStep {
  id: 'google' | 'search' | 'content';
  title: string;
  description: string;
  done: boolean;
  actionLabel: string;
  target: { view: string; sub?: string };
}

export function deriveOnboardingSteps(signals: OnboardingSignals): OnboardingStep[] {
  return [
    {
      id: 'google',
      title: 'Connect Google data',
      description:
        'Search Console shows organic search performance, Analytics shows page traffic, and Ads shows paid search intelligence. Connecting one is enough to start.',
      done: signals.googleConfigured,
      actionLabel: 'Open Google',
      target: { view: 'google' },
    },
    {
      id: 'search',
      title: 'Review your SEO insight',
      description: 'Look at the queries and keyword opportunities for this project, then pick one to write about.',
      done: signals.hasSearchData,
      actionLabel: 'Open Keywords',
      target: { view: 'keywords' },
    },
    {
      id: 'content',
      title: 'Create your first content',
      description: 'Start a draft in the workspace, generate an article, and edit it in place.',
      done: signals.hasContent,
      actionLabel: 'Open workspace',
      target: { view: 'workspace', sub: 'composer' },
    },
  ];
}

export function onboardingComplete(steps: OnboardingStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.done);
}

/** Persist dismissal on the project (server-side settings bag, not localStorage). */
export function dismissOnboarding(projectId: string): Promise<{ ok: boolean }> {
  return api(`/projects/${projectId}/onboarding/dismiss`, { method: 'POST', body: {} });
}
