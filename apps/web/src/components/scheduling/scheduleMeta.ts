import type { ScheduleDto, ScheduleStatus } from '@seo/contracts';

/** Editor-or-higher roles can schedule, reschedule and cancel. */
export const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export const SCHEDULE_STATUSES: ScheduleStatus[] = [
  'scheduled',
  'queued',
  'publishing',
  'published',
  'failed',
  'cancelled',
];

export function canManage(role: string): boolean {
  return (ROLE_RANK[role] ?? 0) >= 1;
}

/** Only a not-yet-queued schedule can move to another time (matches H1 API). */
export function isReschedulable(s: ScheduleDto): boolean {
  return s.status === 'scheduled';
}

/** Only schedules that have not started publishing can be cancelled. */
export function isCancellable(s: ScheduleDto): boolean {
  return s.status === 'scheduled' || s.status === 'queued';
}

export function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function fmtLocalDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(d: Date): string {
  return `${fmtLocalDate(d)} ${fmtTime(d)}`;
}

export function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Local value for an <input type="datetime-local"> (no seconds/zone). */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local value -> absolute ISO timestamp, or null when unparseable. */
export function fromLocalInput(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

export function sameLocalMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
