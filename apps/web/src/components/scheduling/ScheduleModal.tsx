/**
 * Create/reschedule modal for the Content Calendar (Phase H2).
 *
 * Data-driven picks: it loads the project's (non-archived) content and its
 * connected publishers from the API and only offers article/text intents that
 * the chosen publisher can actually carry - the content model has no
 * image/video source yet. Mutations go exclusively through the schedules API
 * and the parent refetches on success; the modal is never optimistic and
 * validates that the chosen instant is in the future.
 */
import { useEffect, useState } from 'react';
import type { PublishContentKind, ScheduleDto } from '@seo/contracts';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/ui';
import { fmtDateTime, fromLocalInput, parseDate, toLocalInput } from './scheduleMeta';
import { defaultPublishKind, PUBLISH_KIND_LABELS, supportedPublishKinds } from '../../lib/publishers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ContentOption {
  id: string;
  title: string | null;
  status: string | null;
}
interface PublisherOption {
  publisher: { id: string; name: string; provider: string; status: string; capabilities?: string[] };
  descriptor: { name: string; capabilities?: string[] } | null;
}

/**
 * Kinds a schedule can express today. The content picker offers article source
 * rows, which can be published as a full article or as a text post; image and
 * video intents need dedicated media sources that do not exist yet.
 */
const SOURCE_KINDS: PublishContentKind[] = ['article', 'text'];

/** Kinds the selected content source can be published as to this publisher. */
function usableKinds(p: PublisherOption): PublishContentKind[] {
  return supportedPublishKinds(p.publisher, p.descriptor).filter((k) => SOURCE_KINDS.includes(k));
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

  const connected = (pubs.data ?? []).filter(
    (p) => p.publisher.status === 'connected' && usableKinds(p).length > 0,
  );

  const [contentId, setContentId] = useState('');
  const [publisherId, setPublisherId] = useState('');
  const [publishKind, setPublishKind] = useState<PublishContentKind>(SOURCE_KINDS[0] ?? 'article');
  const [whenLocal, setWhenLocal] = useState<string>(() =>
    schedule ? toLocalInput(parseDate(schedule.scheduled_at) ?? new Date()) : defaultWhen(),
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Default the intent to the publisher's first supported kind (article first). */
  const applyDefaultKind = (publisherIdValue: string) => {
    const wrap = connected.find((p) => p.publisher.id === publisherIdValue);
    if (!wrap) return;
    const kinds = usableKinds(wrap);
    if (kinds.length === 0) return;
    const preferred = defaultPublishKind(wrap.publisher, wrap.descriptor);
    const chosen = kinds.includes(preferred) ? preferred : kinds[0];
    if (chosen) setPublishKind(chosen);
  };

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
    if (first && !publisherId) {
      setPublisherId(first.publisher.id);
      applyDefaultKind(first.publisher.id);
    }
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
          body: { content_id: contentId, publisher_id: publisherId, publish_kind: publishKind, scheduled_at: iso },
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
  const selectedWrap = connected.find((p) => p.publisher.id === publisherId);
  const selectedKinds = selectedWrap ? usableKinds(selectedWrap) : [];

  const selectPublisher = (idValue: string) => {
    setPublisherId(idValue);
    applyDefaultKind(idValue);
  };

  const selectClass =
    'h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/45 px-4 pb-4 pt-[8vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
        role="dialog"
        aria-modal="true"
        aria-label={creating ? 'Schedule publication' : 'Reschedule'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="m-0 text-[15px] font-semibold">{creating ? 'Schedule a publication' : 'Reschedule'}</h3>
          <button
            type="button"
            className="cursor-pointer border-none bg-transparent px-1 text-xl leading-none text-muted-foreground hover:text-destructive"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {!creating && schedule && (
          <div className="my-1 mb-2">
            <div className="my-1.5 text-[15px] font-semibold">{schedule.content_title ?? 'Untitled'}</div>
            <div className="text-muted-foreground">
              {schedule.publisher_name ?? 'Unknown publisher'} · currently{' '}
              {parseDate(schedule.scheduled_at) ? fmtDateTime(parseDate(schedule.scheduled_at)!) : '—'}
            </div>
          </div>
        )}

        {creating && (
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="sch-article">
              Article
            </label>
            {content.loading && content.data === null && <p className="text-muted-foreground">Loading articles…</p>}
            {!content.loading && content.data !== null && contentRows.length === 0 && (
              <p className="text-muted-foreground">No articles in this project yet. Create one in Content Studio first.</p>
            )}
            {contentRows.length > 0 && (
              <select id="sch-article" className={selectClass} value={contentId} onChange={(e) => setContentId(e.target.value)}>
                {contentRows.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title ?? 'Untitled'} {c.status ? `(${c.status})` : ''}
                  </option>
                ))}
              </select>
            )}

            <label className="text-sm font-medium" htmlFor="sch-publisher">
              Publisher
            </label>
            {pubs.loading && pubs.data === null && <p className="text-muted-foreground">Loading publishers…</p>}
            {!pubs.loading && pubs.data !== null && connected.length === 0 && (
              <p className="text-muted-foreground">No connected publisher. Connect and test one in Publishing first.</p>
            )}
            {connected.length > 0 && (
              <select id="sch-publisher" className={selectClass} value={publisherId} onChange={(e) => selectPublisher(e.target.value)}>
                {connected.map((p) => (
                  <option key={p.publisher.id} value={p.publisher.id}>
                    {p.descriptor?.name ?? p.publisher.name}
                  </option>
                ))}
              </select>
            )}

            {selectedKinds.length > 1 ? (
              <>
                <label className="text-sm font-medium">Publish as</label>
                <div className="flex flex-wrap gap-4">
                  {selectedKinds.map((k) => (
                    <label key={k} className="inline-flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="publish-kind"
                        value={k}
                        checked={publishKind === k}
                        onChange={() => setPublishKind(k)}
                      />
                      {PUBLISH_KIND_LABELS[k]}
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                Will publish as {PUBLISH_KIND_LABELS[publishKind]} ({publishKind}).
              </p>
            )}
          </div>
        )}

        <div className="mt-2 grid gap-2">
          <label className="text-sm font-medium" htmlFor="sch-when">
            When
          </label>
          <Input id="sch-when" type="datetime-local" value={whenLocal} onChange={(e) => setWhenLocal(e.target.value)} />
        </div>

        {err && <div className="mt-2 text-[13px] text-destructive">{err}</div>}

        <div className="mt-4 flex items-center gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || (creating && (contentRows.length === 0 || connected.length === 0))}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : creating ? 'Schedule' : 'Reschedule'}
          </Button>
        </div>
      </div>
    </div>
  );
}
