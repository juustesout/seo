/**
 * Project knowledge sources manager used inside the Content Studio editor.
 *
 * User-managed reference notes/documents are indexed per project into the
 * isolated vector store and are offered as *optional* context to AI actions -
 * never treated as the source of truth for content. Editors (canEdit) can add
 * and remove sources; the panel polls only while a source is busy indexing or
 * deleting so statuses stay live without a permanent interval.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { KnowledgeSourcesResponse } from '@seo/contracts';
import { api } from '../../lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/**
 * Small Content Studio knowledge panel (Phase E). Lists the project's
 * user-managed knowledge sources (status, chunks, errors) and lets editors add
 * notes/reference documents or remove sources. Indexing happens in the
 * background worker; the panel polls only while any source is busy.
 */
export function KnowledgePanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [state, setState] = useState<KnowledgeSourcesResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api<KnowledgeSourcesResponse>(`/projects/${projectId}/knowledge/sources`);
      setState(data);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const busy = useMemo(
    () =>
      (state?.sources ?? []).some((s) => s.status === 'pending' || s.status === 'indexing' || s.status === 'deleting'),
    [state],
  );

  // Poll while any source is being indexed/deleted so statuses stay live.
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => {
      void load();
    }, 4000);
    return () => window.clearInterval(id);
  }, [busy, load]);

  const sources = state?.sources ?? [];

  const addSource = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busyAction) return;
    setBusyAction(true);
    setErr(null);
    try {
      await api(`/projects/${projectId}/knowledge/sources`, {
        method: 'POST',
        body: { name: name.trim(), source_type: 'note', url: url.trim() || null, text: text.trim() || null },
      });
      setName('');
      setUrl('');
      setText('');
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusyAction(false);
    }
  };

  const removeSource = async (id: string, label: string) => {
    if (!window.confirm(`Remove "${label}" from this project's knowledge base?`)) return;
    setErr(null);
    try {
      await api(`/projects/${projectId}/knowledge/sources/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const retrySource = async (id: string) => {
    setErr(null);
    try {
      await api(`/projects/${projectId}/knowledge/sources/${id}/reindex`, { method: 'POST', body: {} });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const configured = state?.configured ?? false;
  const statusPill = (status: string) => {
    if (status === 'indexed') return <Badge variant="success">indexed</Badge>;
    if (status === 'error') return <Badge variant="destructive">error</Badge>;
    if (status === 'deleting') return <Badge variant="warning">deleting…</Badge>;
    if (status === 'indexing') return <Badge variant="warning">indexing…</Badge>;
    return <Badge variant="warning">queued…</Badge>;
  };

  return (
    <section className="mt-3.5 rounded-[10px] border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <strong>Project knowledge</strong>
        <Badge variant={configured ? 'success' : 'destructive'}>{configured ? 'configured' : 'not configured'}</Badge>
      </div>
      <p className="my-1 mb-2.5 text-xs text-muted-foreground">
        Reference notes and documents, indexed per project into the isolated vector base. They are offered as optional
        context to AI actions - never as the source of truth for your content.
      </p>

      {err && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}

      {state && !configured && (
        <div className="mt-1 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          Knowledge is not usable on this server yet. {state.note ?? ''}
        </div>
      )}

      {canEdit && configured && (
        <form className="mb-2.5 grid gap-2" onSubmit={addSource}>
          <Input
            type="text"
            placeholder="Title (e.g. Style guide, competitor note)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
          />
          <Input
            type="text"
            placeholder="URL of the reference (optional)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            maxLength={2000}
          />
          <Textarea
            placeholder="Content to index (paste a reference document or write notes)…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            maxLength={100000}
          />
          <div>
            <Button type="submit" size="sm" disabled={busyAction || !name.trim()}>
              {busyAction ? 'Adding…' : 'Add source'}
            </Button>
          </div>
        </form>
      )}

      {sources.length === 0 && (
        <p className="text-[13px] text-muted-foreground">
          {configured ? 'No sources yet. Add a note or reference document above - it will be embedded in the background.' : 'No sources yet.'}
        </p>
      )}

      {sources.length > 0 && (
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {sources.map((s) => (
            <li key={s.id} className="rounded-lg border bg-muted/40 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <b className="text-[13px]">{s.name}</b>
                {statusPill(s.status)}
                {s.chunk_count > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {s.chunk_count} chunk{s.chunk_count === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              {(s.url || s.source_type) && (
                <div className="font-mono text-xs text-muted-foreground">
                  {s.source_type}
                  {s.url ? ` · ${s.url}` : ''}
                </div>
              )}
              {s.error && <div className="mt-1 whitespace-pre-wrap text-xs text-destructive">{s.error}</div>}
              {canEdit && (
                <div className="mt-1.5 flex gap-1.5">
                  {(s.status === 'error' || s.status === 'pending') && (
                    <Button variant="outline" size="sm" onClick={() => void retrySource(s.id)}>
                      Retry
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => void removeSource(s.id, s.name)}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
