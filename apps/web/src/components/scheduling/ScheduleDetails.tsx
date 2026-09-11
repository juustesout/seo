/**
 * Schedule detail overlay (Content Calendar, Phase H2).
 *
 * Shows one schedule's full state and offers only the actions its status
 * allows: reschedule only while still `scheduled`, cancel only before it has
 * started publishing, and "view publication" once published/failed. All gating
 * comes from scheduleMeta guards plus the `canManage` role flag the parent
 * derives - a read-only project member sees details but no mutation buttons.
 */
import type { ScheduleDto } from '@seo/contracts';
import { StatusPill } from '../../lib/ui';
import { fmtDateTime, isCancellable, isReschedulable, parseDate } from './scheduleMeta';
import { Button } from '@/components/ui/button';

interface ScheduleDetailsProps {
  schedule: ScheduleDto;
  canManage: boolean;
  onClose: () => void;
  onReschedule: (s: ScheduleDto) => void;
  onCancel: (s: ScheduleDto) => void;
  onViewPublication?: () => void;
}

/** Overlay with full details of one schedule and the actions its state allows. */
export function ScheduleDetails({ schedule, canManage, onClose, onReschedule, onCancel, onViewPublication }: ScheduleDetailsProps) {
  const when = parseDate(schedule.scheduled_at);
  const cancelledAt = parseDate(schedule.cancelled_at);
  const createdAt = parseDate(schedule.created_at);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/45 px-4 pb-4 pt-[8vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Schedule details"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="m-0 text-[15px] font-semibold">Schedule</h3>
          <button
            type="button"
            className="cursor-pointer border-none bg-transparent px-1 text-xl leading-none text-muted-foreground hover:text-destructive"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="my-1.5 text-[15px] font-semibold">{schedule.content_title ?? 'Untitled'}</div>
        <div className="my-1 mb-2 flex flex-wrap items-center gap-2">
          <StatusPill status={schedule.status} />
          {schedule.status === 'cancelled' && (
            <span className="text-[11.5px] text-muted-foreground">This schedule was cancelled and will not publish.</span>
          )}
          {schedule.status === 'failed' && (
            <span className="text-[11.5px] text-muted-foreground">
              Publishing failed. The article and history are kept; schedule again to retry.
            </span>
          )}
        </div>

        <dl className="my-2 grid grid-cols-[120px_1fr] gap-x-2.5 gap-y-1.5 text-[13px] [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:break-words [&_dt]:text-muted-foreground">
          <dt>Scheduled for</dt>
          <dd>{when ? fmtDateTime(when) : '—'}</dd>
          <dt>Publisher</dt>
          <dd>{schedule.publisher_name ?? '—'}</dd>
          <dt>Content id</dt>
          <dd className="font-mono">{schedule.content_id}</dd>
          <dt>Created</dt>
          <dd>{createdAt ? fmtDateTime(createdAt) : '—'}</dd>
          {cancelledAt && (
            <>
              <dt>Cancelled</dt>
              <dd>{fmtDateTime(cancelledAt)}</dd>
            </>
          )}
        </dl>

        <div className="mt-4 flex items-center gap-2">
          {onViewPublication && (
            <Button onClick={onViewPublication} title="Open the resulting publication in the history page">
              View publication
            </Button>
          )}
          {canManage && isReschedulable(schedule) && (
            <Button variant="outline" onClick={() => onReschedule(schedule)}>
              Reschedule…
            </Button>
          )}
          {canManage && isCancellable(schedule) && (
            <Button variant="destructive" onClick={() => onCancel(schedule)}>
              Cancel schedule
            </Button>
          )}
          {!canManage && (
            <span className="text-xs text-muted-foreground">Read-only project access — schedules cannot be changed.</span>
          )}
          <span className="flex-1" />
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
