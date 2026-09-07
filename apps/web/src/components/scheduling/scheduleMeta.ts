/**
 * Pure helpers shared by the scheduling views/components (Phase H2).
 *
 * Centralizes the role gate (editor+ may schedule/reschedule/cancel) and all
 * local-timezone date handling for schedules, so calendar cells, lists, detail
 * and the modal agree on one definition of "today", month boundaries and how a
 * datetime-local input maps to an absolute instant. Nothing here talks to the
 * API - it is deterministic formatting and state-machine guards only.
 */
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

/** Parse an ISO/DB timestamp to a Date, or null when absent/unparseable (callers render '—'). */
export function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local HH:mm (24h) for an event chip. */
export function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Local "Wkd, yyyy mon d" label for list/detail rows. */
export function fmtLocalDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

/** Local date + time; the shared human rendering of a scheduled instant. */
export function fmtDateTime(d: Date): string {
  return `${fmtLocalDate(d)} ${fmtTime(d)}`;
}

/** Calendar math in local time (not UTC), so "same day" matches what the user sees. */
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

/** First day of the month containing `d` (local time). */
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Local-time day arithmetic (Date constructor normalizes overflows). */
export function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** Whether two dates fall in the same local month (used to dim out-of-month cells). */
export function sameLocalMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
