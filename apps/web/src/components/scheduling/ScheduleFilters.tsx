import { SCHEDULE_STATUSES } from './scheduleMeta';

interface ScheduleFiltersProps {
  status: string;
  onStatus: (status: string) => void;
  query: string;
  onQuery: (q: string) => void;
}

/** Status + free-text filters for the calendar/list. Cancelled stays visible by default. */
export function ScheduleFilters({ status, onStatus, query, onQuery }: ScheduleFiltersProps) {
  return (
    <div className="sch-filters">
      <select value={status} onChange={(e) => onStatus(e.target.value)} aria-label="Filter by status">
        <option value="all">All statuses</option>
        {SCHEDULE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <input
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Filter by article or publisher…"
        aria-label="Filter by article or publisher"
        style={{ minWidth: 220 }}
      />
    </div>
  );
}
