import type { ScheduleDto } from '@seo/contracts';
import { fmtTime, parseDate } from './scheduleMeta';

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
      className={`sch-ev sch-${schedule.status}`}
      onClick={() => onOpen(schedule)}
      title={`${label} · ${schedule.status}${when ? ` · ${when.toLocaleString()}` : ''}`}
      aria-label={`${label}, ${schedule.status}${when ? `, ${when.toLocaleString()}` : ''}`}
    >
      <span className="sch-ev-time">{when ? fmtTime(when) : '—'}</span>
      <span className="sch-ev-title">{label}</span>
      {cancelled && <span className="sch-ev-cancelled">cancelled</span>}
    </button>
  );
}
