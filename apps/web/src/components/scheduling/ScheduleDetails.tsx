import type { ScheduleDto } from '@seo/contracts';
import { StatusPill } from '../../lib/ui';
import { fmtDateTime, isCancellable, isReschedulable, parseDate } from './scheduleMeta';

interface ScheduleDetailsProps {
  schedule: ScheduleDto;
  canManage: boolean;
  onClose: () => void;
  onReschedule: (s: ScheduleDto) => void;
  onCancel: (s: ScheduleDto) => void;
}

/** Overlay with full details of one schedule and the actions its state allows. */
export function ScheduleDetails({ schedule, canManage, onClose, onReschedule, onCancel }: ScheduleDetailsProps) {
  const when = parseDate(schedule.scheduled_at);
  const cancelledAt = parseDate(schedule.cancelled_at);
  const createdAt = parseDate(schedule.created_at);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label="Schedule details" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Schedule</h3>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="sch-detail-title">{schedule.content_title ?? 'Untitled'}</div>
        <div className="sch-detail-status">
          <StatusPill status={schedule.status} />
          {schedule.status === 'cancelled' && <span className="sch-cancelled-note">This schedule was cancelled and will not publish.</span>}
          {schedule.status === 'failed' && (
            <span className="muted sch-cancelled-note">Publishing failed. The article and history are kept; schedule again to retry.</span>
          )}
        </div>

        <dl className="sch-detail-grid">
          <dt>Scheduled for</dt>
          <dd>{when ? fmtDateTime(when) : '—'}</dd>
          <dt>Publisher</dt>
          <dd>{schedule.publisher_name ?? '—'}</dd>
          <dt>Content id</dt>
          <dd className="mono">{schedule.content_id}</dd>
          <dt>Created</dt>
          <dd>{createdAt ? fmtDateTime(createdAt) : '—'}</dd>
          {cancelledAt && (
            <>
              <dt>Cancelled</dt>
              <dd>{fmtDateTime(cancelledAt)}</dd>
            </>
          )}
        </dl>

        <div className="modal-actions">
          {canManage && isReschedulable(schedule) && (
            <button type="button" className="btn" onClick={() => onReschedule(schedule)}>
              Reschedule…
            </button>
          )}
          {canManage && isCancellable(schedule) && (
            <button type="button" className="btn danger" onClick={() => onCancel(schedule)}>
              Cancel schedule
            </button>
          )}
          {!canManage && <span className="muted sch-note">Read-only project access — schedules cannot be changed.</span>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
