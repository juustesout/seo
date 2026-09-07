import { useEffect, useRef, useState } from 'react';
import type { PublicationDto, PublicationStatus } from '@seo/contracts';
import { api } from '../lib/api';
import { useAsync, StatusPill, Empty } from '../lib/ui';
import { fmtDateTime, parseDate } from '../components/scheduling/scheduleMeta';

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
    <div>
      <h1>Publications</h1>
      <p className="sub">
        History of every publish attempt in this project — who it went to, when, and whether it worked. Planning is done
        on the Calendar; this page shows what happened.
      </p>

      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <select value={filters.status ?? 'all'} onChange={(e) => change({ status: e.target.value as Filters['status'] })}>
          <option value="all">All statuses</option>
          {PUBLICATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={filters.publisher_id ?? ''} onChange={(e) => change({ publisher_id: e.target.value || undefined })}>
          <option value="">All publishers</option>
          {publisherOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn sm" onClick={() => setTick((x) => x + 1)} disabled={loading}>
          Refresh
        </button>
      </div>

      {(filters.content_id || filters.schedule_id) && (
        <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {filters.content_id && (
            <span className="pill">Content: {filters.content_id.slice(0, 8)}… <a href="#" onClick={(e) => { e.preventDefault(); change({ content_id: undefined }); }}>clear</a></span>
          )}
          {filters.schedule_id && (
            <span className="pill">From a calendar schedule <a href="#" onClick={(e) => { e.preventDefault(); change({ schedule_id: undefined }); }}>clear</a></span>
          )}
        </div>
      )}

      {!error && loading && rows.length === 0 && <p className="muted">Loading publications…</p>}
      {!error && !loading && rows.length === 0 && (
        <Empty>
          {filters.content_id || filters.schedule_id
            ? 'No publication attempts match this link.'
            : 'Nothing has been published to a channel yet. Publish an article or create a schedule to see history here.'}
        </Empty>
      )}
      {rows.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Publisher</th>
                <th>When</th>
                <th>Live URL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(p.id)}>
                  <td>
                    <div>{p.content_title ?? 'Untitled'}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {p.schedule_id ? 'Via calendar schedule' : 'Published directly'}
                    </div>
                  </td>
                  <td>
                    <StatusPill status={p.status} />
                  </td>
                  <td>{p.publisher_name ?? '—'}</td>
                  <td className="muted">{fmtWhen(p)}</td>
                  <td className="mono muted" style={{ fontSize: 12 }}>
                    {p.target_url ? <a href={p.target_url} target="_blank" rel="noreferrer">{p.target_url}</a> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && (
            <div className="row" style={{ justifyContent: 'center', padding: 10 }}>
              <button type="button" className="btn" onClick={() => setOffset((o) => o + PAGE)} disabled={loading}>
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && !hasMore && <p className="muted sch-note">End of publication history.</p>}

      {selectedId && <PublicationDetail projectId={projectId} publicationId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function fmtWhen(p: PublicationDto): string {
  if (p.published_at) return fmtDateTime(parseDate(p.published_at) ?? new Date());
  if (p.scheduled_for) return `Planned ${fmtDateTime(parseDate(p.scheduled_for) ?? new Date())}`;
  return fmtDateTime(parseDate(p.created_at) ?? new Date());
}

function PublicationDetail({ projectId, publicationId, onClose }: { projectId: string; publicationId: string; onClose: () => void }) {
  const detail = useAsync<PublicationDto>(
    () => api(`/projects/${projectId}/publications/${publicationId}`),
    [projectId, publicationId],
  );
  const p = detail.data;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label="Publication details" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Publication</h3>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {detail.loading && !p && <p className="muted">Loading…</p>}
        {detail.error && <div className="banner error">{detail.error}</div>}

        {p && (
          <>
            <div className="sch-detail-title">{p.content_title ?? 'Untitled'}</div>
            <div className="sch-detail-status">
              <StatusPill status={p.status} />
              <span className="pill">{p.schedule_id ? 'via calendar schedule' : 'direct'}</span>
              {p.status === 'failed' && p.error && <span className="muted sch-cancelled-note">Failure: {p.error}</span>}
              {p.status === 'published' && p.target_url && (
                <span className="muted sch-cancelled-note">Live at the URL below.</span>
              )}
            </div>

            <dl className="sch-detail-grid">
              <dt>Status</dt>
              <dd className="mono">{p.status}</dd>
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
              <dd className="mono">{p.content_id ?? '—'}</dd>
              <dt>Remote id</dt>
              <dd className="mono">{p.remote_id ?? '—'}</dd>
              <dt>Updated</dt>
              <dd>{fmtDateTime(parseDate(p.updated_at) ?? new Date())}</dd>
            </dl>

            {p.target_url && (
              <div style={{ marginBottom: 12 }}>
                <a className="btn" href={p.target_url} target="_blank" rel="noreferrer">
                  Open live URL
                </a>
              </div>
            )}
            {p.error && p.status === 'failed' && <div className="banner error">Publishing failed: {p.error}</div>}
          </>
        )}

        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
