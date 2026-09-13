/**
 * Knowledge Overview - Health row (KBUI3).
 *
 * The whole-base health at a glance, and the primary work queue: each card is a
 * real link into the Sources view with the matching filter, so "Failed: 3" is
 * one click from the three failed sources. Counts come from the API summary;
 * due/stale are derived freshness counts, never invented.
 */
import type { KnowledgeSourceSummaryDto } from '@seo/contracts';
import { cn } from '@/lib/utils';

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const TONE: Record<Tone, string> = {
  success: 'border-success/30 hover:border-success/60',
  warning: 'border-warning/30 hover:border-warning/60',
  danger: 'border-destructive/30 hover:border-destructive/60',
  neutral: 'border-border hover:border-primary/40',
};

export interface HealthCard {
  key: string;
  label: string;
  value: number;
  tone: Tone;
  /** Leave undefined for a non-actionable count (e.g. Needs attention). */
  params?: Record<string, string>;
}

export function healthCards(summary: KnowledgeSourceSummaryDto, processing: number): HealthCard[] {
  return [
    { key: 'ready', label: 'Ready', value: summary.ready, tone: 'success', params: { status: 'ready' } },
    { key: 'processing', label: 'Processing', value: processing, tone: 'warning', params: { status: 'processing' } },
    { key: 'failed', label: 'Failed', value: summary.failed, tone: 'danger', params: { status: 'failed' } },
    { key: 'due', label: 'Due', value: summary.due, tone: 'warning', params: { freshness: 'due' } },
    { key: 'stale', label: 'Stale', value: summary.stale, tone: 'danger', params: { freshness: 'stale' } },
  ];
}

export function KnowledgeHealth({
  summary,
  processing,
  onOpen,
}: {
  summary: KnowledgeSourceSummaryDto;
  processing: number;
  onOpen: (params: Record<string, string>) => void;
}) {
  const cards = healthCards(summary, processing);
  return (
    <section className="grid gap-2" aria-label="Knowledge health">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Health</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={() => onOpen(card.params!)}
            className={cn('rounded-lg border bg-muted/20 px-3 py-2.5 text-left transition-colors', TONE[card.tone])}
          >
            <div className="text-xl font-semibold tabular-nums">{card.value}</div>
            <div className="text-xs text-muted-foreground">{card.label}</div>
          </button>
        ))}
      </div>
    </section>
  );
}
