/**
 * Status + free-text filters for the Content Calendar.
 *
 * Controlled inputs: the parent owns the values and applies the filtering, so
 * this component is a pure presentational control. Cancelled is a status just
 * like any other and stays visible/filterable by default rather than vanishing.
 */
import { SCHEDULE_STATUSES } from './scheduleMeta';
import { Input } from '@/components/ui/input';

interface ScheduleFiltersProps {
  status: string;
  onStatus: (status: string) => void;
  query: string;
  onQuery: (q: string) => void;
}

/** Status + free-text filters for the calendar/list. Cancelled stays visible by default. */
export function ScheduleFilters({ status, onStatus, query, onQuery }: ScheduleFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={status}
        onChange={(e) => onStatus(e.target.value)}
        aria-label="Filter by status"
      >
        <option value="all">All statuses</option>
        {SCHEDULE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <Input
        type="search"
        className="min-w-[220px] w-auto"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Filter by article or publisher…"
        aria-label="Filter by article or publisher"
      />
    </div>
  );
}
