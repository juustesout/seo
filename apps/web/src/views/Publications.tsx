import { useEffect, useRef, useState } from 'react';
import type { PublicationDto, PublicationStatus } from '@seo/contracts';
import { api } from '../lib/api';
import { useAsync, StatusPill, Empty } from '../lib/ui';
import { fmtDateTime, parseDate } from '../components/scheduling/scheduleMeta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * Publication history (Content Studio Phase H3). This page answers "what
 * happened": chronological attempts to publish content to connected channels.
 * Planning lives in the Calendar; reads here are always project-scoped and
 * paginated on the API (never a full-table client pull). Rows open a detail
 * modal with the safe DTO - no article bodies or credentials.
 */

const PUBLICATION_STATUSES: PublicationStatus[] = [
  'queued',
  'publishing',
  'published',
  'failed',
  'updated',
  'deleted',
  'scheduled',
];

const PAGE = 50;

interface Filters {
  status?: PublicationStatus | 'all';
  publisher_id?: string;
  content_id?: string;
  schedule_id?: string;
}

function fromQuery(): Filters {
  const q = new URLSearchParams(window.location.search);
  const f: Filters = { status: 'all' };
  const status = q.get('status');
  if (status && (PUBLICATION_STATUSES as string[]).includes(status)) f.status = status as PublicationStatus;
  const publisher_id = q.get('publisher_id');
  if (publisher_id) f.publisher_id = publisher_id;
  const content_id = q.get('content_id');
  if (content_id) f.content_id = content_id;
  const schedule_id = q.get('schedule_id');
  if (schedule_id) f.schedule_id = schedule_id;
  return f;
}

function listUrl(projectId: string, f: Filters, offset: number): string {
  const p = new URLSearchParams();
  if (f.status && f.status !== 'all') p.set('status', f.status);
  if (f.publisher_id) p.set('publisher_id', f.publisher_id);
  if (f.content_id) p.set('content_id', f.content_id);
  if (f.schedule_id) p.set('schedule_id', f.schedule_id);
  p.set('limit', String(PAGE));
  p.set('offset', String(offset));
  return `/projects/${projectId}/publications?${p.toString()}`;
}

/**
 * Publication history list ("what happened", project nav "Publications").
 *
 * Props: `projectId` scopes every read. Filters may be seeded from the URL
 * (content_id / schedule_id / publisher_id / status) so the Calendar and
 * Content Studio can deep-link to the relevant attempt; the effect re-runs on
 * URL change so back/forward navigation re-filters. Rows are paginated
 * server-side (never a full-table client pull) and opening one fetches the
 * safe PublicationDto only - no article bodies and no credentials, and every
 * status (including failures) is shown as-is.
 */
export function Publications({ projectId }: { projectId: string }) {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  const [filters, setFilters] = useState<Filters>(() => fromQuery());
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<PublicationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const autoOpenedRef = useRef(false);

  // A deep link (content_id / schedule_id / publisher_id / status in the URL)
  // seeds the filters; re-run whenever the URL changes (back/forward from the
  // Calendar or Content Studio links).
  useEffect(() => {
    setFilters(fromQuery());
    setOffset(0);
    setSelectedId(null);
    autoOpenedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const publishers = useAsync<{ publisher: { id: string; name: string; status: string } }[]>(
    () => api(`/projects/${projectId}/publishers`),
    [projectId],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api<PublicationDto[]>(listUrl(projectId, filters, offset))
      .then((next) => {
        if (!alive) return;
        setRows((prev) => {
          if (offset === 0) return next;
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...next.filter((r) => !seen.has(r.id))];
        });
        setHasMore(next.length === PAGE);
        // Opening a schedule from the Calendar should land on its attempt.
        if (offset === 0 && filters.schedule_id && next.length > 0 && !autoOpenedRef.current) {
          autoOpenedRef.current = true;
          const first = next[0];
          if (first) setSelectedId(first.id);
        }
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, filters, offset, tick]);

  const change = (patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setOffset(0);
    setSelectedId(null);
  };

  const showAll = publishers.data ?? [];
  const publisherOptions = showAll.map((w) => w.publisher);

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Publications"
        description="History of every publish attempt in this project — who it went to, when, and whether it worked. Planning is done on the Calendar; this page shows what happened."
      />

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={filters.status ?? 'all'}
          onChange={(e) => change({ status: e.target.value as Filters['status'] })}
        >
          <option value="all">All statuses</option>
          {PUBLICATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={filters.publisher_id ?? ''}
          onChange={(e) => change({ publisher_id: e.target.value || undefined })}
        >
          <option value="">All publishers</option>
          {publisherOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Button variant="outline" size="sm" onClick={() => setTick((x) => x + 1)} disabled={loading}>
          Refresh
        </Button>
      </div>

      {(filters.content_id || filters.schedule_id) && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.content_id && (
            <Badge variant="outline">
              Content: {filters.content_id.slice(0, 8)}…{' '}
              <a
                href="#"
                className="underline"
                onClick={(e) => {
                  e.preventDefault();
                  change({ content_id: undefined });
                }}
              >
                clear
              </a>
            </Badge>
          )}
          {filters.schedule_id && (
            <Badge variant="outline">
              From a calendar schedule{' '}
              <a
                href="#"
                className="underline"
                onClick={(e) => {
                  e.preventDefault();
                  change({ schedule_id: undefined });
                }}
              >
                clear
              </a>
            </Badge>
          )}
        </div>
      )}

      {!error && loading && rows.length === 0 && <p className="text-sm text-muted-foreground">Loading publications…</p>}
      {!error && !loading && rows.length === 0 && (
        <Empty>
          {filters.content_id || filters.schedule_id
            ? 'No publication attempts match this link.'
            : 'Nothing has been published to a channel yet. Publish an article or create a schedule to see history here.'}
        </Empty>
      )}
      {rows.length > 0 && (
        <Card>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Publisher</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Live URL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id} className="cursor-pointer" onClick={() => setSelectedId(p.id)}>
                    <TableCell>
                      <div>{p.content_title ?? 'Untitled'}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.schedule_id ? 'Via calendar schedule' : 'Published directly'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusPill status={p.status} />
                    </TableCell>
                    <TableCell>{p.publisher_name ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtWhen(p)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {p.target_url ? (
                        <a href={p.target_url} target="_blank" rel="noreferrer" className="underline">
                          {p.target_url}
                        </a>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {hasMore && (
              <div className="flex justify-center p-2.5">
                <Button variant="outline" onClick={() => setOffset((o) => o + PAGE)} disabled={loading}>
                  {loading ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && !hasMore && (
        <p className="mt-3 text-xs text-muted-foreground">End of publication history.</p>
      )}

      {selectedId && (
        <PublicationDetail projectId={projectId} publicationId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

/** Human "when" for a publication: published time, else planned time, else created. */
function fmtWhen(p: PublicationDto): string {
  if (p.published_at) return fmtDateTime(parseDate(p.published_at) ?? new Date());
  if (p.scheduled_for) return `Planned ${fmtDateTime(parseDate(p.scheduled_for) ?? new Date())}`;
  return fmtDateTime(parseDate(p.created_at) ?? new Date());
}

/** Detail modal for one publication attempt; surfaces remote ids, live URL and the real failure message. */
function PublicationDetail({ projectId, publicationId, onClose }: { projectId: string; publicationId: string; onClose: () => void }) {
  const detail = useAsync<PublicationDto>(
    () => api(`/projects/${projectId}/publications/${publicationId}`),
    [projectId, publicationId],
  );
  const p = detail.data;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/45 px-4 pb-4 pt-[8vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Publication details"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="m-0 text-[15px] font-semibold">Publication</h3>
          <button
            type="button"
            className="cursor-pointer border-none bg-transparent px-1 text-xl leading-none text-muted-foreground hover:text-destructive"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {detail.loading && !p && <p className="text-sm text-muted-foreground">Loading…</p>}
        {detail.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {detail.error}
          </div>
        )}

        {p && (
          <>
            <div className="my-1.5 text-[15px] font-semibold">{p.content_title ?? 'Untitled'}</div>
            <div className="my-1 mb-2 flex flex-wrap items-center gap-2">
              <StatusPill status={p.status} />
              <Badge variant="outline">{p.schedule_id ? 'via calendar schedule' : 'direct'}</Badge>
              {p.status === 'failed' && p.error && (
                <span className="text-[11.5px] text-muted-foreground">Failure: {p.error}</span>
              )}
              {p.status === 'published' && p.target_url && (
                <span className="text-[11.5px] text-muted-foreground">Live at the URL below.</span>
              )}
            </div>

            <dl className="my-2 grid grid-cols-[120px_1fr] gap-x-2.5 gap-y-1.5 text-[13px] [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:break-words [&_dt]:text-muted-foreground">
              <dt>Status</dt>
              <dd className="font-mono">{p.status}</dd>
              {p.published_at && (
                <>
                  <dt>Published</dt>
                  <dd>{fmtDateTime(parseDate(p.published_at) ?? new Date())}</dd>
                </>
              )}
              {p.scheduled_for && (
                <>
                  <dt>Scheduled for</dt>
                  <dd>{fmtDateTime(parseDate(p.scheduled_for) ?? new Date())}</dd>
                </>
              )}
              <dt>Publisher</dt>
              <dd>{p.publisher_name ?? p.publisher_id}</dd>
              <dt>Content</dt>
              <dd>{p.content_title ?? '—'}</dd>
              <dt>Content id</dt>
              <dd className="font-mono">{p.content_id ?? '—'}</dd>
              <dt>Remote id</dt>
              <dd className="font-mono">{p.remote_id ?? '—'}</dd>
              <dt>Updated</dt>
              <dd>{fmtDateTime(parseDate(p.updated_at) ?? new Date())}</dd>
            </dl>

            {p.target_url && (
              <div className="mb-3">
                <Button variant="outline" asChild>
                  <a href={p.target_url} target="_blank" rel="noreferrer">
                    Open live URL
                  </a>
                </Button>
              </div>
            )}
            {p.error && p.status === 'failed' && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                Publishing failed: {p.error}
              </div>
            )}
          </>
        )}

        <div className="mt-4 flex items-center gap-2">
          <span className="flex-1" />
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
