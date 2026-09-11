/**
 * Month/Week grid for the Content Calendar (Phase H2).
 *
 * Pure layout over schedules: given a `cursor` month or week it computes the
 * local calendar cells (42 for month, 7 for week) and buckets the passed
 * schedules by their local day. Out-of-month cells are dimmed, today is
 * highlighted, and each cell shows up to four ScheduleEvents plus an overflow
 * count. No data fetching or mutation here - the parent owns both.
 */
import type { ScheduleDto } from '@seo/contracts';
import { addDays, parseDate, sameLocalDay, sameLocalMonth, startOfMonth } from './scheduleMeta';
import { ScheduleEvent } from './ScheduleEvent';
import { cn } from '@/lib/utils';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_CELLS = 42;

function dayEvents(schedules: ScheduleDto[], day: Date): ScheduleDto[] {
  return schedules.filter((s) => {
    const d = parseDate(s.scheduled_at);
    return d !== null && sameLocalDay(d, day);
  });
}

function MonthGrid({ cursor, schedules, onOpen }: { cursor: Date; schedules: ScheduleDto[]; onOpen: (s: ScheduleDto) => void }) {
  const first = startOfMonth(cursor);
  const anchor = addDays(first, -first.getDay());
  const today = new Date();
  const cells: Date[] = [];
  for (let i = 0; i < MONTH_CELLS; i += 1) cells.push(addDays(anchor, i));

  return (
    <div
      className="grid grid-cols-7 overflow-hidden rounded-[10px] border bg-card"
      role="grid"
      aria-label={`Month view ${cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`}
    >
      {DOW.map((d) => (
        <div
          key={d}
          className="border-b px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"
          role="columnheader"
        >
          {d}
        </div>
      ))}
      {cells.map((day) => {
        const events = dayEvents(schedules, day).sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
        const inMonth = sameLocalMonth(day, cursor);
        const isToday = sameLocalDay(day, today);
        return (
          <div
            key={day.toISOString()}
            role="gridcell"
            className={cn(
              'min-h-24 overflow-hidden border-r border-b px-1.5 py-1 text-xs [&:nth-child(7n)]:border-r-0',
              !inMonth && 'opacity-[.42]',
            )}
          >
            <div className={cn('mb-[3px] text-[11px] text-muted-foreground', isToday && 'font-bold text-primary')}>
              {day.getDate()}
            </div>
            <div className="flex flex-col gap-[3px]">
              {events.slice(0, 4).map((s) => (
                <ScheduleEvent key={s.id} schedule={s} onOpen={onOpen} />
              ))}
              {events.length > 4 && (
                <span className="px-0.5 text-[10.5px] text-muted-foreground" aria-label={`${events.length - 4} more schedules this day`}>
                  +{events.length - 4} more
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WeekGrid({ cursor, schedules, onOpen }: { cursor: Date; schedules: ScheduleDto[]; onOpen: (s: ScheduleDto) => void }) {
  const dow = cursor.getDay();
  const monday = addDays(cursor, dow === 0 ? -6 : 1 - dow);
  const today = new Date();
  const days: Date[] = [];
  for (let i = 0; i < 7; i += 1) days.push(addDays(monday, i));

  return (
    <div className="grid grid-cols-7 overflow-hidden rounded-[10px] border bg-card" role="grid" aria-label="Week view">
      {days.map((day) => {
        const events = dayEvents(schedules, day).sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
        const isToday = sameLocalDay(day, today);
        return (
          <div key={day.toISOString()} role="gridcell" className="flex min-w-0 flex-col gap-1.5 border-r p-1.5 last:border-r-0">
            <div className={cn('mb-1.5 text-[11px] text-muted-foreground', isToday && 'font-bold text-primary')}>
              {DOW[day.getDay()]} {day.getDate()} {day.toLocaleDateString(undefined, { month: 'short' })}
            </div>
            <div className="flex max-h-[62vh] flex-col gap-1 overflow-y-auto">
              {events.length === 0 && (
                <div className="py-2 text-center text-[11px] text-muted-foreground">No schedules</div>
              )}
              {events.map((s) => (
                <ScheduleEvent key={s.id} schedule={s} onOpen={onOpen} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Switches between week and month grids for the calendar. Props: `mode`,
 * `cursor` (the visible month/week anchor), the `schedules` to lay out and
 * `onOpen` (open a schedule's detail). Presentational - authorization lives in
 * the parent view.
 */
export function ScheduleCalendar({
  mode,
  cursor,
  schedules,
  onOpen,
}: {
  mode: 'month' | 'week';
  cursor: Date;
  schedules: ScheduleDto[];
  onOpen: (s: ScheduleDto) => void;
}) {
  if (mode === 'week') return <WeekGrid cursor={cursor} schedules={schedules} onOpen={onOpen} />;
  return <MonthGrid cursor={cursor} schedules={schedules} onOpen={onOpen} />;
}
