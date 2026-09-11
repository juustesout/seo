/**
 * Shared presentational helpers and data hooks that keep views thin.
 *
 * Views stay dumb: they fetch through lib/api.ts wrapped by `useAsync`
 * (fetch-on-mount + manual reload) and render the shared primitives defined
 * here. `StatusPill` maps a known status vocabulary to semantic colors and
 * deliberately leaves anything unrecognized neutral grey - a future or
 * provider-specific status is never shown as success until it is explicitly
 * classified (honesty rule). `useJobs` turns the API's background-job list
 * into a `busy` flag and polls only while work is actually running.
 */
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch-on-mount + manual reload hook for API calls. `deps` re-runs the load;
 * `reload` bumps an internal tick to force a refetch without changing deps.
 * `fn` is kept in a ref so the latest closure is always invoked while the
 * effect only restarts on real deps - that is what lets `reload()` be called
 * from polling loops without resubscribing. An `alive` guard drops results
 * after unmount.
 */
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

/** Coerce an unknown value to a finite number (NaN / missing -> 0). */
export function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Coerce an unknown value to a string (null/undefined -> empty string). */
export function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** Format an ISO/date-ish value as a local "YYYY-MM-DD HH:mm" string, or an em dash when absent/invalid. */
export function fmtDate(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16).replace('T', ' ');
}

/** Locale-group a finite number for display (see {@link num}). */
export function fmtNum(v: unknown): string {
  return num(v).toLocaleString();
}

/**
 * Colored status pill. Known success/pending/failure vocabularies map to
 * semantic CSS classes; any unrecognized value renders neutral, so a status the
 * UI has never seen is never painted as an ok state (honesty rule).
 */
export function StatusPill({ status }: { status: unknown }) {
  const s = str(status);
  const variant =
    s === 'connected' || s === 'active' || s === 'success' || s === 'completed' || s === 'published'
      ? 'success'
      : s === 'error' || s === 'failed' || s === 'inactive'
        ? 'destructive'
        : s === 'running' || s === 'queued' || s === 'pending'
          ? 'warning'
          : 'outline';
  return <Badge variant={variant}>{s || '—'}</Badge>;
}

/** Empty-state placeholder with an optional custom message. */
export function Empty({ children }: { children?: React.ReactNode }) {
  return <div className="py-6 text-center text-sm text-muted-foreground">{children ?? 'Nothing here yet'}</div>;
}

/**
 * Loads the most recent background jobs for a project and reports whether any
 * is still running/queued. While busy it polls on an interval so job rows
 * advance in place; polling stops once nothing is busy, so it is bounded and
 * never runs forever behind an idle screen.
 */
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

/** Table of background jobs with status pill, progress and error message. */
export function JobTable({ jobs }: { jobs: any[] }) {
  if (!jobs.length) return <Empty>No background jobs yet</Empty>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Progress</TableHead>
          <TableHead>Message</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((j: any) => (
          <TableRow key={j.id}>
            <TableCell className="font-mono text-xs">{j.job_type}</TableCell>
            <TableCell>
              <StatusPill status={j.status} />
            </TableCell>
            <TableCell className="tabular-nums">{j.progress != null ? `${num(j.progress)}%` : '—'}</TableCell>
            <TableCell className="text-muted-foreground">{j.message || (j.error ? `error: ${j.error}` : '')}</TableCell>
            <TableCell className="text-muted-foreground">{fmtDate(j.created_at)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
