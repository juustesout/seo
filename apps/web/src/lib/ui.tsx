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
import { api } from './api';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from './utils';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Element-wise compare of two dependency arrays (all callers pass primitives). */
function sameDeps(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/**
 * Fetch-on-mount + manual reload hook for API calls. `deps` re-runs the load;
 * `reload` bumps an internal tick to force a refetch without changing deps.
 * `fn` is kept in a ref so the latest closure is always invoked while the
 * effect only restarts on real deps - that is what lets `reload()` be called
 * from polling loops without resubscribing. An `alive` guard drops results
 * after unmount.
 *
 * When `deps` change the payload belongs to the previous scope and is dropped
 * during render, so a project-scoped view never paints another project's data
 * while the new request is in flight. `reload()` deliberately does not clear
 * `data`, so polling refreshes in place.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const prevDepsRef = useRef<unknown[] | null>(null);
  if (prevDepsRef.current === null || !sameDeps(prevDepsRef.current, deps)) {
    prevDepsRef.current = deps;
    setData(null);
    setError(null);
    setLoading(true);
  }

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
 * Section heading used to break page content into a clear hierarchy without
 * wrapping every block in a card. Title is a restrained 15px, with an optional
 * description and right-aligned actions.
 */
export function SectionHeading({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="space-y-0.5">
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
        {description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Light grouping surface: a single subtle border and a 10px radius, no shadow.
 * Use only where content genuinely reads as one discrete object; prefer
 * whitespace and {@link SectionHeading} for everything else.
 */
export function Panel({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border bg-card', className)} {...props} />;
}

/** A faint horizontal rule for separating blocks without a surface. */
export function Divider({ className }: { className?: string }) {
  return <div role="separator" className={cn('h-px w-full bg-border', className)} />;
}

/**
 * A large metric with a label underneath and an optional, pre-formatted hint.
 * A trend figure is only rendered when the caller passes one, so a missing
 * comparison never becomes a fabricated delta (honesty rule).
 */
export function Metric({
  label,
  value,
  hint,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-[13px] text-muted-foreground">{label}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground/80">{hint}</div> : null}
    </div>
  );
}

const STATUS_DOT_TONE: Record<'success' | 'warning' | 'danger' | 'primary' | 'neutral', string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  primary: 'bg-primary',
  neutral: 'bg-muted-foreground/40',
};

/** A small colored dot that communicates status without a colored badge fill. */
export function StatusDot({
  tone = 'neutral',
  className,
}: {
  tone?: keyof typeof STATUS_DOT_TONE;
  className?: string;
}) {
  return <span aria-hidden="true" className={cn('inline-block size-1.5 shrink-0 rounded-full', STATUS_DOT_TONE[tone], className)} />;
}

/**
 * Loads the most recent background jobs for a project and reports whether any
 * is still running/queued. While busy it polls on an interval so job rows
 * advance in place; polling stops once nothing is busy, so it is bounded and
 * never runs forever behind an idle screen.
 */
export function useJobs(projectId: string, enabled: boolean, ms = 4000) {
  const { data, error, reload } = useAsync<any[]>(
    () => api<any[]>(`/projects/${projectId}/jobs?limit=30`),
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

/**
 * Human-readable text for a job/publication error. Durable jobs store their
 * error as a JobError object (jsonb), so a raw template interpolation would
 * render "[object Object]". Strings pass through; a `{ message }` (or
 * `{ error }`) object is reduced to its message; anything else is null so the
 * caller can decide the fallback.
 */
export function jobErrorText(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === 'string') return error.trim() || null;
  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
    const nested = (error as { error?: unknown }).error;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return null;
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
            <TableCell className="text-muted-foreground">
              {j.message || (j.error ? `error: ${jobErrorText(j.error) ?? 'Unknown error'}` : '')}
            </TableCell>
            <TableCell className="text-muted-foreground">{fmtDate(j.created_at)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
