/**
 * Add Source flow (KBUI1) - one deliberate entry for text, URL and files.
 *
 * The user first chooses what they are adding, then sees only that flow; the
 * three forms never compete on one screen. It composes the existing KB3-KB8
 * endpoints (create, upload, collection assignment, ingest) and reports the
 * real lifecycle: a source is "added" the moment the row exists, but indexing
 * is queued in the background and is never claimed as finished here.
 */
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import type { KnowledgeCollectionDto, KnowledgeSourceDto } from '@seo/contracts';
import { api, apiRaw } from '../../../lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { KNOWLEDGE_FILE_ACCEPT } from '../format';

export type AddSourceKind = 'text' | 'url' | 'file';

const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm text-foreground';

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Fall back to the URL's host when the user leaves the title empty. */
function deriveName(url: string): string {
  try {
    return new URL(url).hostname || url.trim().slice(0, 200);
  } catch {
    return url.trim().slice(0, 200);
  }
}

const KIND_LABELS: Record<AddSourceKind, string> = {
  text: 'Text',
  url: 'Website / URL',
  file: 'File',
};

export function AddSourceDialog({
  projectId,
  open,
  initialKind = null,
  collections = [],
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  initialKind?: AddSourceKind | null;
  collections?: KnowledgeCollectionDto[];
  onClose: () => void;
  onCreated: (sourceId: string, kind: AddSourceKind) => void;
}) {
  const [kind, setKind] = useState<AddSourceKind | null>(initialKind);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; kind: AddSourceKind } | null>(null);

  // Reset the whole flow each time it is opened so a previous draft never leaks.
  useEffect(() => {
    if (!open) return;
    setKind(initialKind ?? null);
    setName('');
    setUrl('');
    setText('');
    setCollectionId('');
    setFile(null);
    setBusy(false);
    setError(null);
    setCreated(null);
  }, [open, initialKind]);

  if (!open) return null;

  const assignCollection = async (sourceId: string) => {
    if (!collectionId) return;
    await api(`/projects/${projectId}/knowledge/sources/${sourceId}`, {
      method: 'PATCH',
      body: { collection_id: collectionId },
    });
  };

  const finish = (sourceId: string, sourceKind: AddSourceKind) => {
    setCreated({ id: sourceId, kind: sourceKind });
    onCreated(sourceId, sourceKind);
  };

  const submitText = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ source: KnowledgeSourceDto }>(`/projects/${projectId}/knowledge/sources`, {
        method: 'POST',
        body: { name: name.trim(), source_type: 'text', text: text.trim() },
      });
      await assignCollection(res.source.id);
      finish(res.source.id, 'text');
    } catch (e2) {
      setError(message(e2));
    } finally {
      setBusy(false);
    }
  };

  const submitUrl = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ source: KnowledgeSourceDto }>(`/projects/${projectId}/knowledge/sources`, {
        method: 'POST',
        body: { name: name.trim() || deriveName(trimmed), source_type: 'url', url: trimmed },
      });
      await assignCollection(res.source.id);
      await api(`/projects/${projectId}/knowledge/sources/${res.source.id}/ingest`, { method: 'POST', body: {} });
      finish(res.source.id, 'url');
    } catch (e2) {
      setError(message(e2));
    } finally {
      setBusy(false);
    }
  };

  const submitFile = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiRaw<{ source: KnowledgeSourceDto }>(
        `/projects/${projectId}/knowledge/sources/upload`,
        file,
        { filename: file.name },
      );
      await assignCollection(res.source.id);
      await api(`/projects/${projectId}/knowledge/sources/${res.source.id}/ingest`, { method: 'POST', body: {} });
      finish(res.source.id, 'file');
    } catch (e2) {
      setError(message(e2));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = (e: ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
  };

  const processingNote =
    created?.kind === 'url'
      ? 'Fetching and indexing…'
      : created?.kind === 'file'
        ? 'Uploading and indexing…'
        : 'Processing. We are extracting and indexing the content.';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-label="Add source"
        className="mt-10 w-full max-w-lg rounded-xl border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Add source</h2>
            {!created && !kind && <p className="text-xs text-muted-foreground">What would you like to add?</p>}
          </div>
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {created ? (
          <div className="grid gap-3">
            <div className="rounded-md border bg-muted/20 px-3 py-2">
              <div className="text-sm font-medium">Source added</div>
              <div className="text-xs text-muted-foreground">{processingNote}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onClose}>
                View source
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setCreated(null);
                  setKind(initialKind ?? null);
                  setName('');
                  setUrl('');
                  setText('');
                  setFile(null);
                }}
              >
                Add another
              </Button>
            </div>
          </div>
        ) : !kind ? (
          <div className="grid gap-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => setKind('text')}
              className="grid gap-0.5 rounded-lg border bg-muted/20 p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <span className="text-sm font-medium">Text</span>
              <span className="text-xs text-muted-foreground">Paste notes or reference material</span>
            </button>
            <button
              type="button"
              onClick={() => setKind('url')}
              className="grid gap-0.5 rounded-lg border bg-muted/20 p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <span className="text-sm font-medium">Website / URL</span>
              <span className="text-xs text-muted-foreground">Fetch and index a webpage</span>
            </button>
            <button
              type="button"
              onClick={() => setKind('file')}
              className="grid gap-0.5 rounded-lg border bg-muted/20 p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <span className="text-sm font-medium">File</span>
              <span className="text-xs text-muted-foreground">Upload a document</span>
            </button>
          </div>
        ) : (
          <form className="grid gap-3" onSubmit={kind === 'text' ? submitText : kind === 'url' ? submitUrl : submitFile}>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Adding {KIND_LABELS[kind]}</span>
              <button type="button" className="underline" onClick={() => setKind(null)}>
                change
              </button>
            </div>

            {kind === 'text' && (
              <>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Title
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Content
                  <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={100000} required />
                </label>
              </>
            )}

            {kind === 'url' && (
              <>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Web page URL
                  <Input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com/docs"
                    maxLength={2000}
                    required
                  />
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Title (optional)
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
                </label>
              </>
            )}

            {kind === 'file' && (
              <label className="grid gap-1 text-xs text-muted-foreground">
                File
                <input
                  type="file"
                  accept={KNOWLEDGE_FILE_ACCEPT}
                  onChange={chooseFile}
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                />
              </label>
            )}

            {collections.length > 0 && (
              <label className="grid gap-1 text-xs text-muted-foreground">
                Collection
                <select aria-label="Collection" className={selectClass} value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                  <option value="">Optional</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="flex items-center gap-2">
              <Button
                type="submit"
                disabled={busy || (kind === 'text' ? !name.trim() || !text.trim() : kind === 'url' ? !url.trim() : !file)}
              >
                {busy
                  ? 'Adding…'
                  : kind === 'text'
                    ? 'Add to Knowledge Base'
                    : kind === 'url'
                      ? 'Fetch & index'
                      : 'Upload & index'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
