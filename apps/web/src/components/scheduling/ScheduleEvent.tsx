/**
 * Compact schedule chip used inside Month/Week calendar cells.
 *
 * A single visual element, but it is deliberately never color-only: cancelled
 * schedules render an explicit "cancelled" label (and failed ones a distinct
 * CSS class) so calendar status stays readable without relying on color. Click
 * opens the schedule's detail overlay via onOpen.
 */
import type { ScheduleDto } from '@seo/contracts';
import { fmtTime, parseDate } from './scheduleMeta';
import { cn } from '@/lib/utils';

const STATUS_BORDER: Record<string, string> = {
  scheduled: 'border-l-primary',
  queued: 'border-l-warning',
  publishing: 'border-l-warning',
  published: 'border-l-success',
  failed: 'border-l-destructive',
  cancelled: 'border-l-muted-foreground border-dashed opacity-[.72]',
};

/**
 * Compact schedule chip used inside calendar cells (Month/Week). Always keeps
 * an explicit "cancelled" text label so status never relies on colour alone.
 */
export function ScheduleEvent({ schedule, onOpen }: { schedule: ScheduleDto; onOpen: (s: ScheduleDto) => void }) {
  const when = parseDate(schedule.scheduled_at);
  const cancelled = schedule.status === 'cancelled';
  const label = schedule.content_title ?? 'Untitled';
  return (
    <button
      type="button"
      className={cn(
        'flex w-full min-w-0 items-center gap-1.5 rounded-md border border-l-[3px] bg-muted/40 px-1.5 py-0.5 text-left text-[11px] hover:border-primary',
        STATUS_BORDER[schedule.status] ?? 'border-l-border',
      )}
      onClick={() => onOpen(schedule)}
      title={`${label} · ${schedule.status}${when ? ` · ${when.toLocaleString()}` : ''}`}
      aria-label={`${label}, ${schedule.status}${when ? `, ${when.toLocaleString()}` : ''}`}
    >
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{when ? fmtTime(when) : '—'}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {cancelled && (
        <span className="shrink-0 rounded-[8px] border px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
          cancelled
        </span>
      )}
    </button>
  );
}
