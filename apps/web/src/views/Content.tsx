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

export function Content({ projectId }: { projectId: string }) {
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
    setInitial(d.title);
  }, [detail.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (id: string) => {
    setEditingId(id);
    setInitial('');
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
      setNotice(targetStatus === 'published' ? 'Saved and published.' : 'Saved as draft.');
      setTimeout(() => setRefresh((x) => x + 1), 300);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editingId) return;
    if (!window.confirm('Delete this article permanently?')) return;
    setErr(null);
    try {
      await api(`/projects/${projectId}/content/${editingId}`, { method: 'DELETE' });
      setEditingId(null);
      setRefresh((x) => x + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const dirty = editingId !== null || creating;

  if (!dirty) {
    return (
      <div>
        <h1>Content Studio</h1>
        <p className="sub">
          Structured, block-based articles. content_json is the source of truth; HTML and the outline are rendered
          from it — no raw HTML editing.
        </p>
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

        {notice && <div className="banner ok">{notice}</div>}
        {list.data && list.data.content.length === 0 && <Empty>No content yet. Start your first article above.</Empty>}
        {list.data && list.data.content.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Target keyword</th>
                <th>Score</th>
                <th>Updated</th>
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

  const ADD_TYPES = ['heading', 'paragraph', 'list', 'quote', 'code', 'media', 'link'];

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => setEditingId(null)}>
          ← Back
        </button>
        <h1 style={{ margin: 0 }}>Content Studio</h1>
      </div>

      {err && <div className="banner error">{err}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <label className="fld">Title</label>
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%' }} />

      <div className="grid" style={{ marginTop: 8 }}>
        <div className="card">
          <h3>Metadata</h3>
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
        <button className="btn" onClick={() => save(status === 'published' ? 'draft' : status)} disabled={saving}>
          Save draft
        </button>
        <button className="btn primary" onClick={() => save('published')} disabled={saving}>
          Publish
        </button>
        {editingId && (
          <button className="btn danger" onClick={() => void remove()}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
