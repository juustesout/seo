/**
 * Project knowledge sources manager used inside the Content Studio editor.
 *
 * User-managed reference notes/documents are indexed per project into the
 * isolated vector store and are offered as *optional* context to AI actions -
 * never treated as the source of truth for content. Editors (canEdit) can add
 * and remove sources; the panel polls only while a source is busy indexing or
 * deleting so statuses stay live without a permanent interval.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { knowledgeErrorMessage, type KnowledgeSourcesResponse } from '@seo/contracts';
import { api, apiRaw } from '../../lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/** Accepted upload types (kept in sync with the server allow-list). */
const KNOWLEDGE_FILE_ACCEPT = '.txt,.md,.markdown,.pdf,.docx';

/** Human label for a file source, derived from its stored MIME/extension. */
function fileLabel(contentType: string | null, filename: string | null): string {
  const type = (contentType ?? '').toLowerCase();
  if (type === 'application/pdf' || /\.pdf$/i.test(filename ?? '')) return 'PDF';
  if (type.includes('wordprocessingml') || /\.docx$/i.test(filename ?? '')) return 'DOCX';
  if (type === 'text/markdown' || type === 'text/x-markdown' || /\.markdown?$/i.test(filename ?? '')) return 'Markdown';
  if (type === 'text/plain') return 'Text';
  return (filename?.split('.').pop() ?? 'File').toUpperCase();
}

/** Compact byte size for the source list (e.g. "1.2 MB"). */
function formatBytes(bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
    () => (state?.sources ?? []).some((s) => s.status === 'queued' || s.status === 'processing' || s.status === 'deleted'),
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
    const trimmedText = text.trim();
    const trimmedUrl = url.trim();
    const sourceType = trimmedText ? 'text' : 'url';
    if (sourceType === 'url' && !trimmedUrl) return;
    setBusyAction(true);
    setErr(null);
    try {
      await api(`/projects/${projectId}/knowledge/sources`, {
        method: 'POST',
        body: { name: name.trim(), source_type: sourceType, url: trimmedUrl || null, text: trimmedText || null },
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

  const uploadFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busyAction) return;
    setBusyAction(true);
    setErr(null);
    try {
      await apiRaw(`/projects/${projectId}/knowledge/sources/upload`, file, { filename: file.name });
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

  const ingestSource = async (id: string) => {
    setErr(null);
    try {
      await api(`/projects/${projectId}/knowledge/sources/${id}/ingest`, { method: 'POST', body: {} });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const reindexSource = async (id: string) => {
    setErr(null);
    try {
      await api(`/projects/${projectId}/knowledge/sources/${id}/reindex`, { method: 'POST', body: {} });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const configured = state?.configured ?? false;
  const statusPill = (sourceType: string, status: string) => {
    if (status === 'ready') return <Badge variant="success">ready</Badge>;
    if (status === 'failed') return <Badge variant="destructive">failed</Badge>;
    if (status === 'deleted') return <Badge variant="warning">deleting…</Badge>;
    if (status === 'processing') return <Badge variant="warning">{sourceType === 'url' ? 'fetching…' : 'indexing…'}</Badge>;
    if (status === 'draft') return <Badge variant="outline">draft</Badge>;
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
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busyAction || !name.trim() || (!text.trim() && !url.trim())}>
              {busyAction ? 'Adding…' : 'Add source'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busyAction}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload file
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept={KNOWLEDGE_FILE_ACCEPT}
              className="hidden"
              onChange={uploadFile}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">Upload a TXT, Markdown, PDF or DOCX file (max 10 MB). It is stored privately, then indexed when you press Index.</p>
        </form>
      )}

      {sources.length === 0 && (
        <p className="text-[13px] text-muted-foreground">
          {configured
            ? 'No sources yet. Add text or a URL above, or upload a TXT/Markdown/PDF/DOCX file - indexing happens in the background.'
            : 'No sources yet.'}
        </p>
      )}

      {sources.length > 0 && (
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {sources.map((s) => (
            <li key={s.id} className="rounded-lg border bg-muted/40 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <b className="text-[13px]">{s.name}</b>
                {statusPill(s.source_type, s.status)}
                {s.chunk_count > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {s.chunk_count} chunk{s.chunk_count === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              {s.source_type === 'file' ? (
                <div className="font-mono text-xs text-muted-foreground">
                  {[fileLabel(s.content_type, s.original_filename), formatBytes(s.size_bytes)]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              ) : (
                <div className="font-mono text-xs text-muted-foreground">
                  {s.source_type}
                  {s.url ? ` · ${s.url}` : ''}
                </div>
              )}
              {s.status === 'draft' && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {s.source_type === 'url'
                    ? 'Not fetched yet. Use Fetch to pull the page content into the knowledge base.'
                    : s.source_type === 'file'
                      ? 'Stored privately. Use Index to extract and index this file.'
                      : 'Not indexed yet. Use Index to add this source to the knowledge base.'}
                </div>
              )}
              {s.error && (
                <div className="mt-1 whitespace-pre-wrap text-xs text-destructive">{knowledgeErrorMessage(s.error)}</div>
              )}
              {canEdit && (
                <div className="mt-1.5 flex gap-1.5">
                  {s.status === 'failed' && (
                    <Button variant="outline" size="sm" onClick={() => void ingestSource(s.id)}>
                      Retry
                    </Button>
                  )}
                  {s.status === 'draft' && (
                    <Button variant="outline" size="sm" onClick={() => void ingestSource(s.id)}>
                      {s.source_type === 'url' ? 'Fetch' : 'Index'}
                    </Button>
                  )}
                  {s.status === 'ready' && (
                    <Button variant="outline" size="sm" onClick={() => void reindexSource(s.id)}>
                      Reindex
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
