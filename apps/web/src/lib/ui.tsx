import { useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch-on-mount + manual reload hook for API calls. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef
      .current()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

export function fmtDate(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16).replace('T', ' ');
}

export function fmtNum(v: unknown): string {
  return num(v).toLocaleString();
}

export function StatusPill({ status }: { status: unknown }) {
  const s = str(status);
  const cls =
    s === 'connected' || s === 'active' || s === 'success' || s === 'completed' || s === 'published'
      ? 'ok'
      : s === 'error' || s === 'failed' || s === 'inactive'
        ? 'err'
        : s === 'running' || s === 'queued' || s === 'pending'
          ? 'busy'
          : '';
  return <span className={`pill ${cls}`}>{s || '—'}</span>;
}

export function Empty({ children }: { children?: React.ReactNode }) {
  return <div className="empty">{children ?? 'Nothing here yet'}</div>;
}

/** Poll jobs via the API until no row is running/queued (bounded). */
export function useJobs(projectId: string, enabled: boolean, ms = 4000) {
  const { data, error, reload } = useAsync<any[]>(
    () =>
      fetch(`/api/projects/${projectId}/jobs?limit=30`)
        .then((r) => r.json())
        .then((j) => j.data ?? []),
    [projectId, enabled],
  );
  const busy = (data ?? []).some((j: any) => j.status === 'running' || j.status === 'queued');
  useEffect(() => {
    if (!enabled || !busy) return;
    const id = setInterval(reload, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, busy, ms]);
  return { jobs: (data ?? []) as any[], error: error as string | null, busy, reload };
}

export function JobTable({ jobs }: { jobs: any[] }) {
  if (!jobs.length) return <Empty>No background jobs yet</Empty>;
  return (
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Status</th>
          <th>Progress</th>
          <th>Message</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j: any) => (
          <tr key={j.id}>
            <td className="mono">{j.job_type}</td>
            <td>
              <StatusPill status={j.status} />
            </td>
            <td className="num">{j.progress != null ? `${num(j.progress)}%` : '—'}</td>
            <td className="muted">{j.message || (j.error ? `error: ${j.error}` : '')}</td>
            <td className="muted">{fmtDate(j.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
