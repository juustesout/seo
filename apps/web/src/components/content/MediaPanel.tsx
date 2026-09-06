import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Editor } from '@tiptap/react';
import type { MediaItemDto, MediaListResponse, MediaMimeType } from '@seo/contracts';
import { api, apiRaw } from '../../lib/api';

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
    <section className="media-panel">
      <div className="media-head">
        <strong>Media library</strong>
        <span className="pill ok">{items.length} item{items.length === 1 ? '' : 's'}</span>
      </div>
      <p className="sub muted" style={{ margin: '4px 0 8px', fontSize: 12 }}>
        Images are stored in this project's library. Use Insert to add one at the caret as a mediaId node.
      </p>

      {err && <div className="banner error" style={{ marginBottom: 8 }}>{err}</div>}
      {state && state.note && items.length === 0 && <p className="muted" style={{ fontSize: 12 }}>{state.note}</p>}

      {canEdit && (
        <div className="media-upload">
          <button type="button" className="btn sm" disabled={uploading} onClick={pickFile}>
            {uploading ? 'Uploading…' : '+ Upload PNG/JPEG/WebP'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: 'none' }}
            onChange={onPick}
          />
        </div>
      )}

      {items.length > 0 && (
        <ul className="media-list">
          {items.map((m) => (
            <li key={m.id} className="media-row">
              <div className="media-thumb">
                <img src={m.url} alt={m.alt_text || m.filename} loading="lazy" />
              </div>
              <div className="media-info">
                <div className="media-name" title={m.filename}>
                  {m.filename}
                </div>
                <div className="media-meta muted">
                  {m.width && m.height ? `${m.width}×${m.height} · ` : ''}
                  {fmtSize(m.size)} · {m.usage_count} use{m.usage_count === 1 ? '' : 's'}
                </div>
                {canEdit && (
                  <form
                    className="media-alt-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveAlt(m);
                    }}
                  >
                    <input
                      type="text"
                      placeholder="Alt text (descriptive, not 'image')"
                      value={pendingAlt(m)}
                      maxLength={500}
                      onChange={(e) => setAltDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                    />
                  </form>
                )}
                <div className="media-actions">
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={!editor}
                    title={editor ? 'Insert this image at the caret in the document' : 'Open a document to insert into'}
                    onClick={() => insert(m)}
                  >
                    Insert
                  </button>
                  {canDelete && (
                    <button type="button" className="btn sm danger" title="Delete from the library (refused while used by a document)" onClick={() => void remove(m)}>
                      Delete
                    </button>
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
