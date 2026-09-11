/**
 * Chronological list view of schedules for the Content Calendar (Phase H2).
 *
 * Rows are sorted by scheduled instant and cancelled rows stay visible with a
 * "cancelled" note (never hidden). Action buttons only appear when the caller
 * has manage rights and the row's status still permits them - the guards live
 * in scheduleMeta so list and detail agree on what can be changed.
 */
import type { ScheduleDto } from '@seo/contracts';
import { StatusPill } from '../../lib/ui';
import { fmtDateTime, isCancellable, isReschedulable, parseDate } from './scheduleMeta';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Scheduled for</TableHead>
          <TableHead>Article</TableHead>
          <TableHead>Publisher</TableHead>
          <TableHead>Status</TableHead>
          {showActions && <TableHead>Actions</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((s) => {
          const when = parseDate(s.scheduled_at);
          const cancelled = s.status === 'cancelled';
          const editable = isReschedulable(s) || isCancellable(s);
          return (
            <TableRow
              key={s.id}
              className={cancelled ? 'cursor-pointer opacity-[.68]' : 'cursor-pointer'}
              onClick={() => onOpen(s)}
            >
              <TableCell className="tabular-nums">
                <div>{when ? fmtDateTime(when) : '—'}</div>
                {cancelled && <div className="text-[11.5px] text-muted-foreground">cancelled</div>}
              </TableCell>
              <TableCell>
                <div className={cancelled ? 'line-through opacity-[.72]' : ''}>{s.content_title ?? 'Untitled'}</div>
              </TableCell>
              <TableCell className="text-muted-foreground">{s.publisher_name ?? '—'}</TableCell>
              <TableCell>
                <StatusPill status={s.status} />
              </TableCell>
              {showActions &&
                (editable ? (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-1.5">
                      {isReschedulable(s) && (
                        <Button variant="outline" size="sm" onClick={() => onReschedule(s)}>
                          Reschedule
                        </Button>
                      )}
                      {isCancellable(s) && (
                        <Button variant="outline" size="sm" className="text-destructive" onClick={() => onCancel(s)}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </TableCell>
                ) : (
                  <TableCell />
                ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
