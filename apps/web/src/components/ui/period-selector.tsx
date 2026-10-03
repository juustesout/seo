/**
 * One period selector for every Google analysis (Search Console, Analytics,
 * Ads). Before this, GA4 and Ads each carried their own copy of the same
 * seven/twenty-eight/ninety button row while Search Console was pinned to a
 * hardcoded 28 days. Centralizing the options and the date-range math keeps the
 * three products describing the same window the same way.
 */
import { Button } from '@/components/ui/button';

export const PERIOD_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 7, label: 'Last 7 days' },
  { days: 28, label: 'Last 28 days' },
  { days: 90, label: 'Last 90 days' },
];

export const DEFAULT_PERIOD_DAYS = 28;

/** The human label for a period, falling back to "Last N days" for custom values. */
export function periodLabel(days: number): string {
  return PERIOD_OPTIONS.find((p) => p.days === days)?.label ?? `Last ${days} days`;
}

/**
 * Inclusive UTC date range for the last `days` days ending today. Mirrors the
 * server's Search Console default so a client-selected period and the GSC
 * keyword read agree on "today".
 */
export function periodRange(days: number, today: Date = new Date()): { startDate: string; endDate: string } {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

export function PeriodSelector({ value, onChange }: { value: number; onChange: (days: number) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Period">
      {PERIOD_OPTIONS.map((p) => (
        <Button
          key={p.days}
          type="button"
          size="sm"
          variant={value === p.days ? 'default' : 'outline'}
          aria-pressed={value === p.days}
          onClick={() => onChange(p.days)}
        >
          {p.label}
        </Button>
      ))}
    </div>
  );
}
