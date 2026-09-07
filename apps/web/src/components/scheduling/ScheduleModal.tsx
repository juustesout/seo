import { useEffect, useState } from 'react';
import type { ScheduleDto } from '@seo/contracts';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/ui';
import { fmtDateTime, fromLocalInput, parseDate, toLocalInput } from './scheduleMeta';

interface ContentOption {
  id: string;
  title: string | null;
  status: string | null;
}
interface PublisherOption {
  publisher: { id: string; name: string; provider: string; status: string };
  descriptor: { name: string } | null;
}

/** One hour from now, floored to a clean :00 for a sensible default. */
function defaultWhen(): string {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  return toLocalInput(d);
}

function futureIso(localValue: string): string | null {
  const iso = fromLocalInput(localValue);
  if (!iso) return null;
  return Date.parse(iso) > Date.now() ? iso : null;
}

/**
 * Create or reschedule a schedule (Content Studio Phase H2). Mutations go
 * through the H1 API only; the parent refetches after onSaved. The modal
 * never optimistically updates.
 */
export function ScheduleModal({
  projectId,
  schedule,
  onClose,
  onSaved,
}: {
  projectId: string;
  /** null => create a new schedule; otherwise reschedule this one. */
  schedule: ScheduleDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const creating = schedule === null;

  const content = useAsync<{ content: ContentOption[]; total: number }>(
    () => api(`/projects/${projectId}/content?limit=300`),
    [projectId],
  );
  const pubs = useAsync<PublisherOption[]>(() => api(`/projects/${projectId}/publishers`), [projectId]);

  const connected = (pubs.data ?? []).filter((p) => p.publisher.status === 'connected');

  const [contentId, setContentId] = useState('');
  const [publisherId, setPublisherId] = useState('');
  const [whenLocal, setWhenLocal] = useState<string>(() =>
    schedule ? toLocalInput(parseDate(schedule.scheduled_at) ?? new Date()) : defaultWhen(),
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!creating) return;
    const rows = (content.data?.content ?? []).filter((c) => c.status !== 'archived');
    const first = rows[0];
    if (first && !contentId) setContentId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.data, creating]);

  useEffect(() => {
    if (!creating) return;
    const first = connected[0];
    if (first && !publisherId) setPublisherId(first.publisher.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubs.data, creating]);

  const submit = async () => {
    setErr(null);
    const iso = futureIso(whenLocal);
    if (!iso) {
      setErr('Pick a date and time in the future.');
      return;
    }
    setBusy(true);
    try {
      if (creating) {
        if (!contentId) throw new Error('Pick an article to schedule.');
        if (!publisherId) throw new Error('Pick a publisher.');
        await api(`/projects/${projectId}/schedules`, {
          method: 'POST',
          body: { content_id: contentId, publisher_id: publisherId, scheduled_at: iso },
        });
      } else {
        await api(`/projects/${projectId}/schedules/${schedule!.id}`, {
          method: 'PATCH',
          body: { scheduled_at: iso },
        });
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const contentRows = (content.data?.content ?? []).filter((c) => c.status !== 'archived');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={creating ? 'Schedule publication' : 'Reschedule'} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{creating ? 'Schedule a publication' : 'Reschedule'}</h3>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {!creating && schedule && (
          <div className="modal-context">
            <div className="sch-detail-title">{schedule.content_title ?? 'Untitled'}</div>
            <div className="muted">
              {schedule.publisher_name ?? 'Unknown publisher'} · currently{' '}
              {parseDate(schedule.scheduled_at) ? fmtDateTime(parseDate(schedule.scheduled_at)!) : '—'}
            </div>
          </div>
        )}

        {creating && (
          <>
            <label className="fld">Article</label>
            {content.loading && content.data === null && <p className="muted">Loading articles…</p>}
            {!content.loading && content.data !== null && contentRows.length === 0 && (
              <p className="muted">No articles in this project yet. Create one in Content Studio first.</p>
            )}
            {contentRows.length > 0 && (
              <select value={contentId} onChange={(e) => setContentId(e.target.value)}>
                {contentRows.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title ?? 'Untitled'} {c.status ? `(${c.status})` : ''}
                  </option>
                ))}
              </select>
            )}

            <label className="fld">Publisher</label>
            {pubs.loading && pubs.data === null && <p className="muted">Loading publishers…</p>}
            {!pubs.loading && pubs.data !== null && connected.length === 0 && (
              <p className="muted">No connected publisher. Connect and test one in Publishing first.</p>
            )}
            {connected.length > 0 && (
              <select value={publisherId} onChange={(e) => setPublisherId(e.target.value)}>
                {connected.map((p) => (
                  <option key={p.publisher.id} value={p.publisher.id}>
                    {p.descriptor?.name ?? p.publisher.name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}

        <label className="fld">When</label>
        <input type="datetime-local" value={whenLocal} onChange={(e) => setWhenLocal(e.target.value)} />

        {err && <div className="error-line">{err}</div>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || (creating && (contentRows.length === 0 || connected.length === 0))}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : creating ? 'Schedule' : 'Reschedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
