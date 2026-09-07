import { useEffect, useMemo, useState } from 'react';
import type { ScheduleDto } from '@seo/contracts';
import { api } from '../lib/api';
import { useAsync, Empty } from '../lib/ui';
import { ScheduleCalendar } from '../components/scheduling/ScheduleCalendar';
import { ScheduleList } from '../components/scheduling/ScheduleList';
import { ScheduleFilters } from '../components/scheduling/ScheduleFilters';
import { ScheduleModal } from '../components/scheduling/ScheduleModal';
import { ScheduleDetails } from '../components/scheduling/ScheduleDetails';
import { canManage, fmtLocalDate, parseDate } from '../components/scheduling/scheduleMeta';

type ViewMode = 'month' | 'week' | 'list';

const MODES: Array<{ id: ViewMode; label: string }> = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'list', label: 'List' },
];

function startOfWeek(d: Date): Date {
  const dow = d.getDay();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (dow === 0 ? -6 : 1 - dow));
}

/**
 * Content scheduling surface (Content Studio Phase H2). Pure UI over the H1
 * schedules API: month/week/list views, filters, and create / reschedule /
 * cancel flows. Mutations always round-trip through the API and then refetch;
 * nothing here is optimistic.
 */
export function ContentSchedule({ projectId, role = 'viewer' }: { projectId: string; role?: string }) {
  const manage = canManage(role);

  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState<ViewMode>('month');
  const [cursor, setCursor] = useState(() => new Date());
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [rescheduling, setRescheduling] = useState<ScheduleDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const state = useAsync<ScheduleDto[]>(() => api(`/projects/${projectId}/schedules`), [projectId, refresh]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const reload = () => setRefresh((x) => x + 1);

  const schedules = useMemo(() => {
    const rows = state.data ?? [];
    const q = query.trim().toLowerCase();
    return rows.filter((s) => {
      if (status !== 'all' && s.status !== status) return false;
      if (!q) return true;
      return `${s.content_title ?? ''} ${s.publisher_name ?? ''}`.toLowerCase().includes(q);
    });
  }, [state.data, status, query]);

  const selected = schedules.find((s) => s.id === selectedId) ?? null;
  const hadAny = (state.data ?? []).length > 0;

  const stepCursor = (dir: number) =>
    setCursor((prev) => {
      const n = new Date(prev);
      if (mode === 'month') n.setMonth(n.getMonth() + dir);
      else n.setDate(n.getDate() + dir * 7);
      return n;
    });

  const rangeLabel =
    mode === 'month'
      ? cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : (() => {
          const start = startOfWeek(cursor);
          const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
          const sameMonth = start.getMonth() === end.getMonth();
          const f = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          return sameMonth
            ? `${f(start)} – ${end.getDate()}, ${end.toLocaleDateString(undefined, { year: 'numeric' })}`
            : `${f(start)} – ${f(end)}`;
        })();

  const openDetails = (s: ScheduleDto) => setSelectedId(s.id);

  const cancelSchedule = async (s: ScheduleDto) => {
    const when = parseDate(s.scheduled_at);
    const ok = window.confirm(
      `Cancel the scheduled publication of "${s.content_title ?? 'this article'}"${when ? ` on ${fmtLocalDate(when)}` : ''}?\n` +
        'The schedule is kept as cancelled so you can review it later, and the article is untouched.',
    );
    if (!ok) return;
    setErr(null);
    try {
      await api(`/projects/${projectId}/schedules/${s.id}`, { method: 'DELETE' });
      setSelectedId(null);
      setNotice('Schedule cancelled.');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const saved = (msg: string) => {
    setCreating(false);
    setRescheduling(null);
    setSelectedId(null);
    setNotice(msg);
    reload();
  };

  return (
    <div>
      <h1>Content Calendar</h1>
      <p className="sub">
        Plan article publications on your connected publishers. Times are absolute and shown in your local timezone;
        cancelled schedules stay visible for review.
      </p>

      {err && <div className="banner error">{err}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <div className="sch-toolbar">
        <div className="sch-nav">
          {mode !== 'list' && (
            <>
              <button type="button" className="btn sm" onClick={() => stepCursor(-1)} aria-label="Previous">
                ‹
              </button>
              <button type="button" className="btn sm" onClick={() => setCursor(new Date())}>
                Today
              </button>
              <button type="button" className="btn sm" onClick={() => stepCursor(1)} aria-label="Next">
                ›
              </button>
              <span className="sch-range">{rangeLabel}</span>
            </>
          )}
        </div>
        <div className="sch-view">
          {MODES.map((m) => (
            <button key={m.id} type="button" className={`btn sm ${mode === m.id ? 'primary' : ''}`} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
          {manage && (
            <button type="button" className="btn sm primary sch-new" onClick={() => setCreating(true)}>
              + Schedule
            </button>
          )}
        </div>
      </div>

      <div className="sch-filterbar">
        <ScheduleFilters status={status} onStatus={setStatus} query={query} onQuery={setQuery} />
        <button type="button" className="btn sm" onClick={reload} disabled={state.loading}>
          Refresh
        </button>
      </div>

      {state.error && (
        <div className="banner error" style={{ marginTop: 8 }}>
          Could not load schedules: {state.error}
        </div>
      )}
      {!state.error && state.loading && state.data === null && <p className="muted">Loading schedules…</p>}
      {state.data && schedules.length === 0 && (
        <Empty>
          {hadAny ? 'No schedules match the current filters.' : manage ? 'No schedules yet. Use “+ Schedule” to plan a publication.' : 'No schedules yet.'}
        </Empty>
      )}
      {state.data && schedules.length > 0 && mode === 'list' && (
        <ScheduleList
          schedules={schedules}
          canManage={manage}
          onOpen={openDetails}
          onReschedule={(s) => {
            setSelectedId(null);
            setRescheduling(s);
          }}
          onCancel={cancelSchedule}
        />
      )}
      {state.data && schedules.length > 0 && mode !== 'list' && (
        <ScheduleCalendar mode={mode} cursor={cursor} schedules={schedules} onOpen={openDetails} />
      )}

      {!manage && state.data && schedules.length > 0 && (
        <p className="muted sch-note">Read-only project access — schedules can be viewed but not changed.</p>
      )}

      {selected && (
        <ScheduleDetails
          schedule={selected}
          canManage={manage}
          onClose={() => setSelectedId(null)}
          onReschedule={(s) => {
            setSelectedId(null);
            setRescheduling(s);
          }}
          onCancel={cancelSchedule}
        />
      )}
      {creating && (
        <ScheduleModal projectId={projectId} schedule={null} onClose={() => setCreating(false)} onSaved={() => saved('Publication scheduled.')} />
      )}
      {rescheduling && (
        <ScheduleModal projectId={projectId} schedule={rescheduling} onClose={() => setRescheduling(null)} onSaved={() => saved('Schedule updated.')} />
      )}
    </div>
  );
}
