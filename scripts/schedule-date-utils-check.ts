/**
 * Focused smoke checks for Content Studio Phase H2 date/grouping helpers
 * (apps/web/src/components/scheduling/scheduleMeta.ts).
 *
 * Calendar-day bucketing must use LOCAL calendar days: an absolute schedule
 * timestamp must land on the day the user sees in their own timezone, including
 * the UTC-midnight boundary and DST transitions. Run this script once per
 * timezone (see h2-schedule-utils-check.sh); Node reads TZ at process start.
 */

import {
  addDays,
  fromLocalInput,
  parseDate,
  sameLocalDay,
  sameLocalMonth,
  startOfMonth,
  toLocalInput,
} from '../apps/web/src/components/scheduling/scheduleMeta';

type Day = { y: number; m: number; d: number };
type Case = { iso: string; y: number; m: number; d: number };

const ZONE = process.env.TZ ?? 'UTC';

const BOUNDARY_CASES: Record<string, Case[]> = {
  UTC: [
    { iso: '2026-09-07T00:30:00Z', y: 2026, m: 9, d: 7 },
    { iso: '2026-09-07T23:30:00Z', y: 2026, m: 9, d: 7 },
  ],
  'Etc/GMT+12': [
    { iso: '2026-09-07T00:30:00Z', y: 2026, m: 9, d: 6 },
    { iso: '2026-09-07T23:30:00Z', y: 2026, m: 9, d: 7 },
  ],
  'Etc/GMT-14': [
    { iso: '2026-09-07T00:30:00Z', y: 2026, m: 9, d: 7 },
    { iso: '2026-09-07T23:30:00Z', y: 2026, m: 9, d: 8 },
  ],
  'Europe/Amsterdam': [
    { iso: '2026-09-07T00:30:00Z', y: 2026, m: 9, d: 7 },
    { iso: '2026-09-07T23:30:00Z', y: 2026, m: 9, d: 8 },
    { iso: '2026-03-29T01:30:00Z', y: 2026, m: 3, d: 29 },
    { iso: '2026-11-07T00:30:00Z', y: 2026, m: 11, d: 7 },
  ],
  'America/New_York': [
    { iso: '2026-09-07T00:30:00Z', y: 2026, m: 9, d: 6 },
    { iso: '2026-09-07T23:30:00Z', y: 2026, m: 9, d: 7 },
    { iso: '2026-03-08T07:00:00Z', y: 2026, m: 3, d: 8 },
    { iso: '2026-11-01T04:30:00Z', y: 2026, m: 11, d: 1 },
    { iso: '2026-11-01T06:30:00Z', y: 2026, m: 11, d: 1 },
  ],
};

let failures = 0;

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}: expected ${e}, got ${a}`);
  }
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dayCell(c: Day): Date {
  return new Date(c.y, c.m - 1, c.d);
}

function shifted(c: Day, delta: number): Day {
  const base = new Date(c.y, c.m - 1, c.d + delta);
  return { y: base.getFullYear(), m: base.getMonth() + 1, d: base.getDate() };
}

function checkBoundary(c: Case) {
  const instant = new Date(c.iso);
  const expected: Day = { y: c.y, m: c.m, d: c.d };
  const prev = shifted(expected, -1);
  const next = shifted(expected, 1);
  eq(`[${ZONE}] ${c.iso} renders as local ${ymd(instant)}`, ymd(instant), ymd(dayCell(expected)));
  eq(`[${ZONE}] ${c.iso} buckets on ${c.y}-${c.m}-${c.d}`, sameLocalDay(instant, dayCell(expected)), true);
  eq(`[${ZONE}] ${c.iso} NOT on previous local day`, sameLocalDay(instant, dayCell(prev)), false);
  eq(`[${ZONE}] ${c.iso} NOT on next local day`, sameLocalDay(instant, dayCell(next)), false);
}

const cases = BOUNDARY_CASES[ZONE];
if (!cases) {
  console.error(`No boundary cases registered for TZ '${ZONE}'`);
  process.exit(1);
}

console.log(`Running schedule date-helper checks in TZ ${ZONE}…`);
cases.forEach(checkBoundary);

// Month grid invariants (independent of timezone): 6 weeks anchored on a Sunday.
const cursor = new Date(2026, 8, 15);
const start = startOfMonth(cursor);
eq('startOfMonth of Sep 2026', ymd(start), '2026-09-01');
const anchor = addDays(start, -start.getDay());
eq('anchor is a Sunday', anchor.getDay(), 0);
const last = addDays(anchor, 41);
eq('last cell is a Saturday', last.getDay(), 6);
eq('grid spans 42 cells', Math.round((last.getTime() - anchor.getTime()) / 86_400_000), 41);
eq('anchor is previous month (out-of-month cell)', sameLocalMonth(anchor, start), false);
eq('first day of month is in-month', sameLocalMonth(start, start), true);

// datetime-local display round trip keeps the local wall-clock the user picked.
const base = new Date('2026-09-07T10:15:00Z');
const round = new Date(fromLocalInput(toLocalInput(base)) ?? NaN);
eq('datetime-local round trip keeps local wall-clock', localKey(round), localKey(base));
eq('invalid datetime-local returns null', fromLocalInput('not-a-date'), null);
eq('invalid ISO returns null', parseDate('garbage'), null);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed in TZ ${ZONE}`);
  process.exit(1);
}
console.log(`All checks passed in TZ ${ZONE}.\n`);
