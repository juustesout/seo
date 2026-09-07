import type { ScheduleDto } from '@seo/contracts';
import { addDays, parseDate, sameLocalDay, sameLocalMonth, startOfMonth } from './scheduleMeta';
import { ScheduleEvent } from './ScheduleEvent';

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
    <div className="sch-grid" role="grid" aria-label={`Month view ${cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`}>
      {DOW.map((d) => (
        <div key={d} className="sch-dow" role="columnheader">
          {d}
        </div>
      ))}
      {cells.map((day) => {
        const events = dayEvents(schedules, day).sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
        const inMonth = sameLocalMonth(day, cursor);
        const isToday = sameLocalDay(day, today);
        return (
          <div key={day.toISOString()} role="gridcell" className={`sch-day ${inMonth ? '' : 'sch-day-out'}`}>
            <div className={`sch-day-num ${isToday ? 'sch-day-today' : ''}`}>{day.getDate()}</div>
            <div className="sch-day-events">
              {events.slice(0, 4).map((s) => (
                <ScheduleEvent key={s.id} schedule={s} onOpen={onOpen} />
              ))}
              {events.length > 4 && (
                <span className="sch-more" aria-label={`${events.length - 4} more schedules this day`}>
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
    <div className="sch-week" role="grid" aria-label="Week view">
      {days.map((day) => {
        const events = dayEvents(schedules, day).sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
        const isToday = sameLocalDay(day, today);
        return (
          <div key={day.toISOString()} role="gridcell" className="sch-wcol">
            <div className={`sch-day-num ${isToday ? 'sch-day-today' : ''}`}>
              {DOW[day.getDay()]} {day.getDate()} {day.toLocaleDateString(undefined, { month: 'short' })}
            </div>
            <div className="sch-wcol-events">
              {events.length === 0 && <div className="sch-wempty muted">No schedules</div>}
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
