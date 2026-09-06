import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { KnowledgeSourcesResponse } from '@seo/contracts';
import { api } from '../../lib/api';

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
    if (status === 'indexed') return <span className="pill ok">indexed</span>;
    if (status === 'error') return <span className="pill err">error</span>;
    if (status === 'deleting') return <span className="pill busy">deleting…</span>;
    if (status === 'indexing') return <span className="pill busy">indexing…</span>;
    return <span className="pill busy">queued…</span>;
  };

  return (
    <section className="card kno-panel">
      <div className="kno-head">
        <strong>Project knowledge</strong>
        <span className={configured ? 'pill ok' : 'pill err'}>{configured ? 'configured' : 'not configured'}</span>
      </div>
      <p className="sub muted kno-sub">
        Reference notes and documents, indexed per project into the isolated vector base. They are offered as optional
        context to AI actions - never as the source of truth for your content.
      </p>

      {err && <div className="banner error">{err}</div>}

      {state && !configured && (
        <div className="banner" style={{ marginTop: 4 }}>
          Knowledge is not usable on this server yet. {state.note ?? ''}
        </div>
      )}

      {canEdit && configured && (
        <form className="kno-form" onSubmit={addSource}>
          <input
            type="text"
            placeholder="Title (e.g. Style guide, competitor note)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
          />
          <input
            type="text"
            placeholder="URL of the reference (optional)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            maxLength={2000}
          />
          <textarea
            placeholder="Content to index (paste a reference document or write notes)…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            maxLength={100000}
          />
          <button type="submit" className="btn primary sm" disabled={busyAction || !name.trim()}>
            {busyAction ? 'Adding…' : 'Add source'}
          </button>
        </form>
      )}

      {sources.length === 0 && (
        <p className="muted" style={{ fontSize: 13 }}>
          {configured ? 'No sources yet. Add a note or reference document above - it will be embedded in the background.' : 'No sources yet.'}
        </p>
      )}

      {sources.length > 0 && (
        <ul className="kno-list">
          {sources.map((s) => (
            <li key={s.id} className="kno-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <b style={{ fontSize: 13 }}>{s.name}</b>
                {statusPill(s.status)}
                {s.chunk_count > 0 && <span className="muted" style={{ fontSize: 12 }}>{s.chunk_count} chunk{s.chunk_count === 1 ? '' : 's'}</span>}
              </div>
              {(s.url || s.source_type) && (
                <div className="mono muted" style={{ fontSize: 12 }}>
                  {s.source_type}
                  {s.url ? ` · ${s.url}` : ''}
                </div>
              )}
              {s.error && <div className="kno-error">{s.error}</div>}
              {canEdit && (
                <div className="kno-actions">
                  {(s.status === 'error' || s.status === 'pending') && (
                    <button type="button" className="btn sm" onClick={() => void retrySource(s.id)}>
                      Retry
                    </button>
                  )}
                  <button type="button" className="btn sm danger" onClick={() => void removeSource(s.id, s.name)}>
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
