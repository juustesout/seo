import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAsync, fmtDate, Empty } from '../lib/ui';
import { renderContentHtml, contentWordCount, slugifyTitle, type ContentBlock } from '@seo/contracts';

interface ContentRow {
  meta_title: string | null;
  meta_description: string | null;
  id: string;
  title: string;
  slug: string | null;
  status: string;
  url: string | null;
  excerpt: string | null;
  target_keyword: string | null;
  seo_score: number | null;
  updated_at: string | null;
  published_at: string | null;
}

type Meta = Partial<{
  target_keyword: string | null;
  meta_title: string | null;
  meta_description: string | null;
  slug: string | null;
}>;

const STATUSES = ['draft', 'in_review', 'published', 'archived'] as const;
const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

function newBlock(type: string, index: number): ContentBlock {
  const base = { id: `b${Date.now()}-${index}` };
  switch (type) {
    case 'heading':
      return { ...base, type: 'heading', attrs: { level: 2, text: '' } } as ContentBlock;
    case 'list':
      return { ...base, type: 'list', attrs: { ordered: false, items: [] } } as ContentBlock;
    case 'quote':
      return { ...base, type: 'quote', attrs: { text: '' } } as ContentBlock;
    case 'code':
      return { ...base, type: 'code', attrs: { text: '' } } as ContentBlock;
    case 'media':
      return { ...base, type: 'media', attrs: { kind: 'placeholder', alt: 'image' } } as ContentBlock;
    case 'link':
      return { ...base, type: 'link', attrs: { text: '', href: '' } } as ContentBlock;
    case 'paragraph':
    default:
      return { ...base, type: 'paragraph', attrs: { text: '' } } as ContentBlock;
  }
}

function BlockEditor({ block, onChange }: { block: ContentBlock; onChange: (b: ContentBlock) => void }) {
  switch (block.type) {
    case 'heading':
      return (
        <div>
          <select
            value={block.attrs.level}
            onChange={(e) => onChange({ ...block, attrs: { ...block.attrs, level: Number(e.target.value) } as never })}
          >
            {[1, 2, 3, 4, 5, 6].map((l) => (
              <option key={l} value={l}>
                H{l}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Heading text"
            value={block.attrs.text}
            onChange={(e) => onChange({ ...block, attrs: { ...block.attrs, text: e.target.value } })}
          />
        </div>
      );
    case 'paragraph':
      return (
        <textarea
          rows={2}
          placeholder="Paragraph text"
          value={block.attrs.text}
          onChange={(e) => onChange({ ...block, attrs: { ...block.attrs, text: e.target.value } })}
        />
      );
    case 'list':
      return (
        <div>
          <label className="fld">
            <input
              type="checkbox"
              checked={Boolean(block.attrs.ordered)}
              onChange={(e) => onChange({ ...block, attrs: { ...block.attrs, ordered: e.target.checked } })}
            />{' '}
            numbered list
          </label>
          <textarea
            rows={4}
            placeholder="One item per line"
            value={block.attrs.items.join('\n')}
            onChange={(e) =>
              onChange({ ...block, attrs: { ...block.attrs, items: e.target.value.split('\n') } })
            }
          />
        </div>
      );
    case 'quote':
      return (
        <div>
          <textarea
            rows={2}
            placeholder="Quote"
            value={block.attrs.text}
            onChange={(e) => onChange({ ...block, attrs: { ...block.attrs, text: e.target.value } })}
          />
          <input
            type="text"
            placeholder="Attribution (optional)"
            value={block.attrs.cite ?? ''}
            onChange={(e) => onChange({ ...block, attrs: { ...block.attrs, cite: e.target.value } })}
          />
        </div>
      );
    case 'code':
      return (
        <textarea
          rows={4}
          className="mono"
          placeholder="Code"
          value={block.attrs.text}
          onChange={(e) => onChange({ ...block, attrs: { ...block.attrs, text: e.target.value } })}
        />
      );
    case 'media':
      return (
        <div>
          <select
            value={block.attrs.kind}
            onChange={(e) =>
              onChange({ ...block, attrs: { ...block.attrs, kind: e.target.value as never } })
            }
          >
            <option value="placeholder">Media placeholder</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
          </select>
          <input
            type="text"
            placeholder="Source URL (optional)"
            value={block.attrs.src ?? ''}
            onChange={(e) => onChange({ ...block, attrs: { ...block.attrs, src: e.target.value } })}
          />
          <input
            type="text"
            placeholder="Alt text / caption"
            value={block.attrs.alt ?? ''}
            onChange={(e) => onChange({ ...block, attrs: { ...block.attrs, alt: e.target.value } })}
          />
        </div>
      );
    case 'link':
      return (
        <div>
          <input
            type="text"
            placeholder="Link text"
            value={block.attrs.text}
            onChange={(e) => onChange({ ...block, attrs: { ...block.attrs, text: e.target.value } })}
          />
          <input
            type="text"
            placeholder="https://…"
            value={block.attrs.href}
            onChange={(e) => onChange({ ...block, attrs: { ...block.attrs, href: e.target.value } })}
          />
        </div>
      );
    default:
      return null;
  }
}

export function Content({ projectId, role = 'viewer' }: { projectId: string; role?: string }) {
  const rank = ROLE_RANK[role] ?? 0;
  const canEdit = rank >= 1;
  const canDelete = rank >= 2;

  const [refresh, setRefresh] = useState(0);
  const list = useAsync<{ content: ContentRow[]; total: number }>(
    () => api(`/projects/${projectId}/content?limit=300`),
    [projectId, refresh],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState('');
  const [meta, setMeta] = useState<Meta>({});
  const [status, setStatus] = useState('draft');
  const [blocks, setBlocks] = useState<ContentBlock[]>([]);
  const [initial, setInitial] = useState<string>('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [lastSnapshot, setLastSnapshot] = useState('');

  const snapOf = (t: string, s: string, m: Meta, b: ContentBlock[]) => JSON.stringify([t, s, m, b]);
  const dirty = snapOf(title, status, meta, blocks) !== lastSnapshot;

  const detail = useAsync<ContentRow & { content_json: ContentBlock[]; content_html: string | null; outline: unknown }>(
    () => api(`/projects/${projectId}/content/${editingId}`),
    [projectId, editingId],
  );

  useEffect(() => {
    if (!detail.data || detail.data.title === initial) return;
    const d = detail.data;
    setTitle(d.title);
    setStatus(d.status);
    setBlocks(Array.isArray(d.content_json) && d.content_json.length ? d.content_json : []);
    setMeta({
      slug: d.slug,
      target_keyword: d.target_keyword,
      meta_title: d.meta_title,
      meta_description: d.meta_description,
    });
    setSavedAt(d.updated_at ?? null);
    setLastSnapshot(
      snapOf(d.title, d.status, {
        slug: d.slug,
        target_keyword: d.target_keyword,
        meta_title: d.meta_title,
        meta_description: d.meta_description,
      } as Meta,
      Array.isArray(d.content_json) ? d.content_json : []),
    );
    setInitial(d.title);
  }, [detail.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (id: string) => {
    setEditingId(id);
    setInitial('');
    setErr(null);
  };

  const goList = () => {
    setEditingId(null);
    setCreating(false);
    setNotice(null);
    setErr(null);
  };

  const html = useMemo(() => renderContentHtml(blocks), [blocks]);
  const words = useMemo(() => contentWordCount(blocks), [blocks]);

  const updateBlock = (i: number, b: ContentBlock) => setBlocks((prev) => prev.map((x, idx) => (idx === i ? b : x)));
  const move = (i: number, dir: -1 | 1) =>
    setBlocks((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const moved = next.splice(i, 1)[0];
      if (!moved) return prev;
      next.splice(j, 0, moved);
      return next;
    });
  const removeBlock = (i: number) => setBlocks((prev) => prev.filter((_x, idx) => idx !== i));

  const save = async (targetStatus: string) => {
    setErr(null);
    setNotice(null);
    setSaving(true);
    try {
      const payload = {
        title,
        slug: meta.slug && slugifyTitle(meta.slug) !== slugifyTitle(title) ? meta.slug : undefined,
        status: targetStatus,
        target_keyword: meta.target_keyword ?? null,
        meta_title: meta.meta_title ?? null,
        meta_description: meta.meta_description ?? null,
        content_json: blocks,
      };
      if (editingId) {
        await api(`/projects/${projectId}/content/${editingId}`, { method: 'PATCH', body: payload });
      } else {
        const created = await api<{ id: string }>(`/projects/${projectId}/content`, {
          method: 'POST',
          body: { ...payload, title },
        });
        setEditingId(created.id);
      }
      setStatus(targetStatus);
      setSavedAt(new Date().toISOString());
      setLastSnapshot(snapOf(title, targetStatus, meta, blocks));
      setNotice(targetStatus === 'published' ? 'Saved and published.' : `Saved as ${targetStatus}.`);
      setTimeout(() => setRefresh((x) => x + 1), 300);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (next: string) => {
    if (next === status) return;
    await save(next);
  };

  const remove = async (id: string | null) => {
    if (!id) return;
    const row = list.data?.content.find((c) => c.id === id);
    if (!window.confirm(`Delete "${row?.title ?? 'this article'}" permanently?`)) return;
    setErr(null);
    try {
      await api(`/projects/${projectId}/content/${id}`, { method: 'DELETE' });
      if (editingId === id) {
        setEditingId(null);
        setCreating(false);
        setNotice(null);
      }
      setRefresh((x) => x + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!creating && editingId === null) {
    return (
      <div>
        <h1>Content Studio</h1>
        <p className="sub">
          Structured, block-based articles. content_json is the source of truth; HTML and the outline are rendered
          from it — no raw HTML editing.
        </p>
        {canEdit && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newTitle.trim()) return;
              setCreating(true);
              setEditingId(null);
              setTitle(newTitle);
              setNewTitle('');
              setBlocks([newBlock('heading', 0), newBlock('paragraph', 1)]);
            }}
          >
            <input
              type="text"
              placeholder="New article title…"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              style={{ minWidth: 320 }}
            />
            <button className="btn primary" disabled={!newTitle.trim()}>
              Start article
            </button>
          </form>
        )}
        {!canEdit && <p className="muted">You have read-only access to this project's content.</p>}
        {notice && <div className="banner ok">{notice}</div>}
        {err && <div className="banner error">{err}</div>}
        {list.data && list.data.content.length === 0 && <Empty>No content yet{canEdit ? '. Start your first article above.' : '.'}</Empty>}
        {list.data && list.data.content.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Target keyword</th>
                <th>Score</th>
                <th>Updated</th>
                {canDelete && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {list.data.content.map((c) => (
                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => open(c.id)}>
                  <td>
                    <div>{c.title}</div>
                    <div className="muted mono">{c.slug ?? '—'}</div>
                  </td>
                  <td>
                    <span className={`pill ${c.status === 'published' ? 'ok' : ''}`}>{c.status}</span>
                  </td>
                  <td className="muted">{c.target_keyword ?? '—'}</td>
                  <td className="num">{c.seo_score != null ? Math.round(c.seo_score) : '—'}</td>
                  <td className="muted">{fmtDate(c.updated_at)}</td>
                  {canDelete && (
                    <td>
                      <button
                        className="btn sm danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(c.id);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  if (editingId && !detail.data) {
    return (
      <div>
        <h1>Content Studio</h1>
        <p className="sub">Loading…</p>
      </div>
    );
  }

  // Read-only workspace for viewers: no editing affordances, content rendered.
  if (!canEdit && detail.data) {
    const d = detail.data;
    return (
      <div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" onClick={goList}>
            ← Back
          </button>
          <h1 style={{ margin: 0 }}>{d.title}</h1>
          <span className={`pill ${d.status === 'published' ? 'ok' : ''}`}>{d.status}</span>
        </div>
        <p className="sub muted">
          {d.updated_at ? `Updated ${fmtDate(d.updated_at)}` : ''}
          {d.target_keyword ? ` · Target keyword: ${d.target_keyword}` : ''}
        </p>
        {d.content_html ? (
          <div className="card">
            <div dangerouslySetInnerHTML={{ __html: d.content_html }} />
          </div>
        ) : (
          <p className="muted">This document has no content yet.</p>
        )}
        <p className="muted" style={{ fontSize: 12 }}>
          Read-only view — you do not have edit access to this project.
        </p>
      </div>
    );
  }

  const ADD_TYPES = ['heading', 'paragraph', 'list', 'quote', 'code', 'media', 'link'];

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" onClick={goList}>
          ← Back
        </button>
        <h1 style={{ margin: 0 }}>Content Studio</h1>
        <span className={`pill ${status === 'published' ? 'ok' : ''}`}>{status}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          {saving ? 'Saving…' : dirty ? 'Unsaved changes' : savedAt ? `Saved ${fmtDate(savedAt)}` : '—'}
        </span>
      </div>

      {err && <div className="banner error">{err}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <label className="fld">Title</label>
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%' }} />

      <div className="grid" style={{ marginTop: 8 }}>
        <div className="card">
          <h3>Metadata</h3>
          <label className="fld">Status</label>
          <select value={status} disabled={saving} onChange={(e) => void changeStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <label className="fld">Target keyword</label>
          <input
            type="text"
            value={meta.target_keyword ?? ''}
            onChange={(e) => setMeta((m) => ({ ...m, target_keyword: e.target.value }))}
          />
          <label className="fld">Slug</label>
          <input
            type="text"
            value={meta.slug ?? ''}
            placeholder="leave empty to derive from title"
            onChange={(e) => setMeta((m) => ({ ...m, slug: e.target.value }))}
          />
          <label className="fld">Meta title</label>
          <input
            type="text"
            value={meta.meta_title ?? ''}
            onChange={(e) => setMeta((m) => ({ ...m, meta_title: e.target.value }))}
          />
          <label className="fld">Meta description</label>
          <textarea
            rows={2}
            value={meta.meta_description ?? ''}
            onChange={(e) => setMeta((m) => ({ ...m, meta_description: e.target.value }))}
          />
        </div>
        <div className="card">
          <h3>Blocks</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
            {ADD_TYPES.map((t) => (
              <button key={t} className="btn sm" onClick={() => setBlocks((b) => [...b, newBlock(t, b.length)])}>
                + {t}
              </button>
            ))}
          </div>
          {blocks.length === 0 && <Empty>No blocks yet — add one above.</Empty>}
          {blocks.map((block, i) => (
            <div key={block.id ?? i} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                <span className="pill mono">{i + 1}</span>
                <button className="btn sm" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button className="btn sm" disabled={i === blocks.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button className="btn sm danger" onClick={() => removeBlock(i)}>
                  remove
                </button>
              </div>
              <BlockEditor block={block} onChange={(b) => updateBlock(i, b)} />
            </div>
          ))}
          <div className="muted" style={{ marginTop: 6 }}>
            {words} words rendered as HTML in the preview.
          </div>
        </div>
        <div className="card">
          <h3>HTML preview</h3>
          <p className="sub mono" style={{ fontSize: 12 }}>
            Rendered from blocks — never edited directly.
          </p>
          <div style={{ fontSize: 13 }}>
            {html ? (
              <div dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <span className="muted">Nothing to render yet.</span>
            )}
          </div>
        </div>
      </div>

      <div className="row">
        <button className="btn" onClick={() => void save(status === 'published' ? 'draft' : status)} disabled={saving}>
          Save draft
        </button>
        {status !== 'published' && (
          <button className="btn primary" onClick={() => void save('published')} disabled={saving}>
            Publish
          </button>
        )}
        {canDelete && editingId && (
          <button className="btn danger" onClick={() => void remove(editingId)} disabled={saving}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
