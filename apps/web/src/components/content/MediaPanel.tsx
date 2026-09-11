/**
 * Media library for the Content Studio (Phase F).
 *
 * Images live in a per-project media library; the editor document only ever
 * references them by `mediaId`, never as a data-URL blob. Uploads stream raw
 * bytes through apiRaw (server sniffs the real format; the size cap here is a
 * courtesy guard, the server enforces it too). Deletion is admin-gated and the
 * API refuses to delete an item still referenced by a document.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Editor } from '@tiptap/react';
import type { MediaItemDto, MediaListResponse, MediaMimeType } from '@seo/contracts';
import { api, apiRaw } from '../../lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const MAX_BYTES = 8 * 1024 * 1024;

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function mimeFor(file: File): MediaMimeType {
  if (/^image\/(png|jpeg|webp)$/.test(file.type)) return file.type as MediaMimeType;
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

/**
 * Content Studio media library panel (Phase F). Lists the project's images,
 * uploads new ones (raw bytes, verified server-side), edits library alt text
 * and inserts a selected image into the document at the caret as a stable
 * `mediaId` node. Deletion follows the "no deletion while referenced" rule and
 * is admin-gated.
 */
export function MediaPanel({
  projectId,
  editor,
  canEdit,
  canDelete,
}: {
  projectId: string;
  editor: Editor | null;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const [state, setState] = useState<MediaListResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [altDrafts, setAltDrafts] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<MediaListResponse>(`/projects/${projectId}/media`);
      setState(data);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = state?.media ?? [];

  const uploadFile = async (file: File) => {
    if (!canEdit) return;
    setErr(null);
    if (file.size > MAX_BYTES) {
      setErr('That image is larger than the 8 MB upload limit.');
      return;
    }
    setUploading(true);
    try {
      await apiRaw<{ media: MediaItemDto }>(`/projects/${projectId}/media`, file, { filename: file.name });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
    e.target.value = '';
  };

  const insert = (m: MediaItemDto) => {
    if (!editor) return;
    const alt = window.prompt('Alt text for this image (used for SEO when placed in the article)', m.alt_text || '');
    if (alt === null) return;
    const altValue = alt.trim();
    editor
      .chain()
      .focus()
      .insertMedia({ mediaId: m.id, src: m.url, alt: altValue, caption: m.caption || '' })
      .run();
  };

  const saveAlt = async (m: MediaItemDto) => {
    if (!canEdit) return;
    const value = (altDrafts[m.id] ?? m.alt_text).trim();
    if (value === m.alt_text) {
      setAltDrafts((d) => ({ ...d, [m.id]: m.alt_text }));
      return;
    }
    setErr(null);
    try {
      await api(`/projects/${projectId}/media/${m.id}`, { method: 'PATCH', body: { alt_text: value } });
      await load();
      setAltDrafts((d) => ({ ...d, [m.id]: value }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (m: MediaItemDto) => {
    if (!canDelete) return;
    if (!window.confirm(`Delete "${m.filename}" from the project library?`)) return;
    setErr(null);
    try {
      await api(`/projects/${projectId}/media/${m.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      // The library owns assets: deleting an item still used by a document is
      // refused by the API, and that message is exactly what the user needs.
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const pendingAlt = (m: MediaItemDto) => (altDrafts[m.id] !== undefined ? altDrafts[m.id] : m.alt_text);

  const pickFile = (e: FormEvent) => {
    e.preventDefault();
    fileRef.current?.click();
  };

  return (
    <section className="rounded-[10px] border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <strong>Media library</strong>
        <Badge variant="success">
          {items.length} item{items.length === 1 ? '' : 's'}
        </Badge>
      </div>
      <p className="my-1 mb-2 text-xs text-muted-foreground">
        Images are stored in this project's library. Use Insert to add one at the caret as a mediaId node.
      </p>

      {err && (
        <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}
      {state && state.note && items.length === 0 && <p className="text-xs text-muted-foreground">{state.note}</p>}

      {canEdit && (
        <div className="mb-1 mt-2">
          <Button variant="outline" size="sm" disabled={uploading} onClick={pickFile}>
            {uploading ? 'Uploading…' : '+ Upload PNG/JPEG/WebP'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={onPick}
          />
        </div>
      )}

      {items.length > 0 && (
        <ul className="mt-1.5 grid max-h-[46vh] list-none gap-2.5 overflow-y-auto p-0">
          {items.map((m) => (
            <li key={m.id} className="flex items-start gap-2.5 rounded-lg border bg-muted/40 p-2">
              <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-card">
                <img src={m.url} alt={m.alt_text || m.filename} loading="lazy" className="max-h-full max-w-full object-cover" />
              </div>
              <div className="grid min-w-0 flex-1 gap-1">
                <div className="truncate text-[12.5px] font-semibold" title={m.filename}>
                  {m.filename}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {m.width && m.height ? `${m.width}×${m.height} · ` : ''}
                  {fmtSize(m.size)} · {m.usage_count} use{m.usage_count === 1 ? '' : 's'}
                </div>
                {canEdit && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveAlt(m);
                    }}
                  >
                    <Input
                      type="text"
                      className="h-7 px-1.5 text-[11.5px]"
                      placeholder="Alt text (descriptive, not 'image')"
                      value={pendingAlt(m)}
                      maxLength={500}
                      onChange={(e) => setAltDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                    />
                  </form>
                )}
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    disabled={!editor}
                    title={editor ? 'Insert this image at the caret in the document' : 'Open a document to insert into'}
                    onClick={() => insert(m)}
                  >
                    Insert
                  </Button>
                  {canDelete && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive"
                      title="Delete from the library (refused while used by a document)"
                      onClick={() => void remove(m)}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
