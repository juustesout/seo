/**
 * First-value onboarding checklist (P6a).
 *
 * `OnboardingChecklist` is the project-aware container: it reads real state
 * (the three Google connections plus whether any content exists), derives the
 * steps, and hides itself once every step is done or the project dismissed it.
 * `FirstValueChecklist` is the presentational half so the states can be tested
 * without network mocks. Nothing here invents sample data or new integrations.
 */
import { Check, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/ui';
import { projectGscState } from '@/lib/gsc';
import { projectAnalyticsState } from '@/lib/analytics';
import { projectAdsState } from '@/lib/ads';
import { googleProductState } from '@/lib/googleStatus';
import {
  deriveOnboardingSteps,
  dismissOnboarding,
  onboardingComplete,
  type OnboardingStep,
} from '@/lib/onboarding';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Presentational checklist: safe to render with any step completion state. */
export function FirstValueChecklist({
  steps,
  onSelect,
  onDismiss,
}: {
  steps: OnboardingStep[];
  onSelect: (target: OnboardingStep['target']) => void;
  onDismiss: () => void;
}) {
  const done = steps.filter((s) => s.done).length;
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle>Get started</CardTitle>
          <p className="text-sm text-muted-foreground">
            {done} of {steps.length} done. Follow these steps to get your first result.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" aria-label="Dismiss getting started" onClick={onDismiss}>
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3">
          {steps.map((step) => (
            <li key={step.id} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-xs',
                  step.done ? 'border-success bg-success/15 text-success' : 'border-muted-foreground/40 text-muted-foreground',
                )}
              >
                {step.done ? <Check className="size-3.5" /> : null}
              </span>
              <div className="grid gap-1">
                <span className={cn('text-sm font-medium', step.done && 'text-muted-foreground line-through')}>
                  {step.title}
                </span>
                <span className="text-sm text-muted-foreground">{step.description}</span>
                {!step.done && (
                  <div>
                    <Button type="button" size="sm" variant="outline" onClick={() => onSelect(step.target)}>
                      {step.actionLabel}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

interface ContentList {
  content: unknown[];
  total: number;
}

export function OnboardingChecklist({
  projectId,
  role,
  hasSearchData,
  dismissed,
  onDismissed,
  onOpenView,
}: {
  projectId: string;
  role: string;
  hasSearchData: boolean;
  dismissed: boolean;
  onDismissed: () => void;
  onOpenView: (view: string, sub?: string) => void;
}) {
  const active = role !== 'viewer' && !dismissed;

  const google = useAsync(
    () =>
      active
        ? Promise.all([projectGscState(projectId), projectAnalyticsState(projectId), projectAdsState(projectId)])
        : Promise.resolve(null),
    [projectId, active],
  );
  const content = useAsync<ContentList>(
    () => (active ? api<ContentList>(`/projects/${projectId}/content?limit=1`) : Promise.resolve({ content: [], total: 0 })),
    [projectId, active],
  );

  if (!active) return null;
  if (google.error || content.error) return null;
  if (!google.data || !content.data) return null;

  const googleConfigured = google.data.some((state) => googleProductState(state) === 'connected');
  const hasContent = content.data.content.length > 0;
  const steps = deriveOnboardingSteps({ googleConfigured, hasSearchData, hasContent });
  if (onboardingComplete(steps)) return null;

  return (
    <FirstValueChecklist
      steps={steps}
      onSelect={(target) => onOpenView(target.view, target.sub)}
      onDismiss={() => {
        onDismissed();
        void dismissOnboarding(projectId).catch(() => {
          /* dismissal is best-effort; the card also auto-hides once complete */
        });
      }}
    />
  );
}
