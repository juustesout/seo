import type { ScheduleDto } from '@seo/contracts';
import { StatusPill } from '../../lib/ui';
import { fmtDateTime, isCancellable, isReschedulable, parseDate } from './scheduleMeta';

interface ScheduleListProps {
  schedules: ScheduleDto[];
  canManage: boolean;
  onOpen: (s: ScheduleDto) => void;
  onReschedule: (s: ScheduleDto) => void;
  onCancel: (s: ScheduleDto) => void;
}

/** Chronological list of schedules. Cancelled rows stay discoverable with a readable label. */
export function ScheduleList({ schedules, canManage, onOpen, onReschedule, onCancel }: ScheduleListProps) {
  const rows = [...schedules].sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
  const showActions = canManage && rows.some((r) => isReschedulable(r) || isCancellable(r));

  return (
    <table>
      <thead>
        <tr>
          <th>Scheduled for</th>
          <th>Article</th>
          <th>Publisher</th>
          <th>Status</th>
          {showActions && <th>Actions</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => {
          const when = parseDate(s.scheduled_at);
          const cancelled = s.status === 'cancelled';
          const editable = isReschedulable(s) || isCancellable(s);
          return (
            <tr key={s.id} className={cancelled ? 'sch-row-cancelled' : ''} onClick={() => onOpen(s)}>
              <td className="num">
                <div>{when ? fmtDateTime(when) : '—'}</div>
                {cancelled && <div className="sch-cancelled-note">cancelled</div>}
              </td>
              <td>
                <div className={cancelled ? 'sch-title-cancelled' : ''}>{s.content_title ?? 'Untitled'}</div>
              </td>
              <td className="muted">{s.publisher_name ?? '—'}</td>
              <td>
                <StatusPill status={s.status} />
              </td>
              {showActions &&
                (editable ? (
                  <td onClick={(e) => e.stopPropagation()}>
                    {isReschedulable(s) && (
                      <button type="button" className="btn sm" onClick={() => onReschedule(s)}>
                        Reschedule
                      </button>
                    )}
                    {isCancellable(s) && (
                      <button type="button" className="btn sm danger" onClick={() => onCancel(s)}>
                        Cancel
                      </button>
                    )}
                  </td>
                ) : (
                  <td />
                ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
