import { useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  asTipDoc,
  docHeadings,
  docWordCount,
  evaluateSeo,
  tiptapEmptyDoc,
  type ContentAiAction,
  type ContentAiSuggestionDto,
  type ContentOutlineItem,
  type ProjectAiStatusDto,
  type SeoResult,
  type TipDoc,
} from '@seo/contracts';
import { api } from '../lib/api';
import { useAsync, fmtDate, Empty } from '../lib/ui';
import { RichTextEditor, type RichTextEditorHandle } from '../components/content/RichTextEditor';
import { ContentToolbar } from '../components/content/ContentToolbar';
import { ContentOutline } from '../components/content/ContentOutline';
import { ContentEditorHeader } from '../components/content/ContentEditorHeader';
import { SeoPanel } from '../components/content/SeoPanel';
import { ContentAiPanel } from '../components/content/ContentAiPanel';
import { textToBlocksHtml } from '../components/content/contentAi';
import { useAutosave } from '../components/content/useAutosave';

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

type DetailRow = ContentRow & { content_json: unknown; content_html: string | null; outline: unknown };

const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

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
  const [loadSeq, setLoadSeq] = useState(0);

  // Editor workspace state.
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('draft');
  const [doc, setDoc] = useState<TipDoc>(() => tiptapEmptyDoc());
  const [targetKeyword, setTargetKeyword] = useState('');
  const [metaTitle, setMetaTitle] = useState('');
  const [metaDescription, setMetaDescription] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<RichTextEditorHandle | null>(null);

  // In-editor AI action state (review-before-apply; never auto-applies).
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSuggestion, setAiSuggestion] = useState<ContentAiSuggestionDto | null>(null);
  const [aiSelRange, setAiSelRange] = useState<{ from: number; to: number } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  const detail = useAsync<DetailRow>(() => api(`/projects/${projectId}/content/${editingId}`), [projectId, editingId]);

  // Synchronous mirror of the current workspace so autosave always reads the
  // latest document/title/status, even mid-render or right after a state update.
  const live = useRef({ title, status, doc, targetKeyword, metaTitle, metaDescription });
  live.current = { title, status, doc, targetKeyword, metaTitle, metaDescription };

  const outline: ContentOutlineItem[] = useMemo(() => docHeadings(doc), [doc]);
  const wordCount = useMemo(() => docWordCount(doc), [doc]);
  const seo = useMemo<SeoResult>(
    () =>
      evaluateSeo({
        doc,
        meta: {
          title,
          targetKeyword: targetKeyword.trim() || null,
          metaTitle: metaTitle.trim() || null,
          metaDescription: metaDescription.trim() || null,
        },
      }),
    [doc, title, targetKeyword, metaTitle, metaDescription],
  );

  const viewerSeo = useMemo<SeoResult | null>(() => {
    const row = detail.data;
    if (!row) return null;
    return evaluateSeo({
      doc: asTipDoc(row.content_json),
      meta: {
        title: row.title ?? '',
        targetKeyword: typeof row.target_keyword === 'string' ? row.target_keyword : null,
        metaTitle: typeof row.meta_title === 'string' ? row.meta_title : null,
        metaDescription: typeof row.meta_description === 'string' ? row.meta_description : null,
      },
    });
  }, [detail.data]);

  const workspaceReady = creating || (editingId !== null && detail.data?.id === editingId);

  const snapshotOf = (t: string, s: string, d: TipDoc, k: string, mt: string, md: string) =>
    JSON.stringify({ t, s, d, k, mt, md });

  const commit = async (snapshot: string) => {
    const parsed = JSON.parse(snapshot) as { t: string; s: string; d: TipDoc; k: string; mt: string; md: string };
    const body = {
      title: parsed.t,
      status: parsed.s,
      content_json: parsed.d,
      target_keyword: parsed.k.trim() || null,
      meta_title: parsed.mt.trim() || null,
      meta_description: parsed.md.trim() || null,
    };
    const row = editingId
      ? await api<ContentRow>(`/projects/${projectId}/content/${editingId}`, { method: 'PATCH', body })
      : await api<ContentRow>(`/projects/${projectId}/content`, { method: 'POST', body });
    if (!editingId && row) setEditingId(row.id);
    if (row) {
      setSavedAt(row.updated_at ?? new Date().toISOString());
      setSlug(row.slug ?? null);
    }
    window.setTimeout(() => setRefresh((x) => x + 1), 250);
  };

  const auto = useAutosave({
    enabled: workspaceReady && canEdit,
    delayMs: 1600,
    makeSnapshot: () =>
      snapshotOf(live.current.title, live.current.status, live.current.doc, live.current.targetKeyword, live.current.metaTitle, live.current.metaDescription),
    persist: commit,
  });

  const loadedRef = useRef<string | null>(null);

  // Seed an existing row into the workspace exactly once per open.
  useEffect(() => {
    if (!editingId) return;
    const row = detail.data;
    if (!row || row.id !== editingId || loadedRef.current === editingId) return;
    loadedRef.current = editingId;
    const next = asTipDoc(row.content_json);
    const kw = typeof row.target_keyword === 'string' ? row.target_keyword : '';
    const mt = typeof row.meta_title === 'string' ? row.meta_title : '';
    const md = typeof row.meta_description === 'string' ? row.meta_description : '';
    live.current = { title: row.title ?? '', status: row.status ?? 'draft', doc: next, targetKeyword: kw, metaTitle: mt, metaDescription: md };
    setTitle(row.title ?? '');
    setStatus(row.status ?? 'draft');
    setDoc(next);
    setTargetKeyword(kw);
    setMetaTitle(mt);
    setMetaDescription(md);
    setSlug(row.slug ?? null);
    setSavedAt(row.updated_at ?? null);
    auto.setBaseline(snapshotOf(live.current.title, live.current.status, next, kw, mt, md));
  }, [editingId, detail.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seed a brand-new document so opening the editor never auto-creates a row.
  useEffect(() => {
    if (!creating) return;
    const next = tiptapEmptyDoc();
    live.current = { ...live.current, doc: next };
    setDoc(next);
    auto.setBaseline(
      snapshotOf(live.current.title, live.current.status, next, live.current.targetKeyword, live.current.metaTitle, live.current.metaDescription),
    );
  }, [creating]); // eslint-disable-line react-hooks/exhaustive-deps

  // AI provider availability (account BYOK + env) for this project.
  useEffect(() => {
    let alive = true;
    if (!workspaceReady || !canEdit || !editingId) return;
    api<ProjectAiStatusDto>(`/projects/${projectId}/ai`)
      .then((s) => {
        if (alive) setAiConfigured(Boolean(s.configured));
      })
      .catch(() => {
        if (alive) setAiConfigured(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, workspaceReady, canEdit, editingId]);

  // Keep the toolbar's "AI" action availability in sync with the selection.
  useEffect(() => {
    if (!editor) return;
    const sync = () => setHasSelection(!editor.state.selection.empty);
    sync();
    editor.on('selectionUpdate', sync);
    editor.on('transaction', sync);
    return () => {
      editor.off('selectionUpdate', sync);
      editor.off('transaction', sync);
    };
  }, [editor]);

  const open = (id: string) => {
    setEditingId(id);
    setCreating(false);
    setErr(null);
    setNotice(null);
    loadedRef.current = null;
    resetAi();
    setLoadSeq((n) => n + 1);
  };

  const startNew = () => {
    setCreating(true);
    setEditingId(null);
    setTitle(newTitle);
    setNewTitle('');
    setErr(null);
    setNotice(null);
    loadedRef.current = null;
    resetAi();
    setLoadSeq((n) => n + 1);
  };

  const goList = () => {
    setEditingId(null);
    setCreating(false);
    setNotice(null);
    setErr(null);
    loadedRef.current = null;
    resetAi();
    setLoadSeq((n) => n + 1);
  };

  const resetAi = () => {
    setAiBusy(false);
    setAiError(null);
    setAiSuggestion(null);
    setAiSelRange(null);
  };

  const changeStatus = (next: string) => {
    if (!canEdit || !workspaceReady || next === live.current.status) return;
    live.current.status = next;
    setStatus(next);
    auto.saveNow();
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

  // --- AI document actions (structured suggestions, review-before-apply) ---

  const runAi = async (action: ContentAiAction) => {
    if (!editor || !editingId || aiBusy) return;
    const needsSel = action !== 'generate_section';
    const { from, to, empty } = editor.state.selection;
    if (needsSel && (empty || from >= to)) {
      setAiError('Select the text you want to edit first.');
      return;
    }
    let tone: string | null = null;
    if (action === 'tone') {
      const value = window.prompt('Describe the tone you want (e.g. professional, friendly, persuasive)', 'Professional');
      if (value === null) return;
      tone = value.trim() || null;
    }
    const selText = needsSel ? editor.state.doc.textBetween(from, to, '\n') : '';
    const ctxFrom = Math.max(0, from - 600);
    const context = needsSel ? editor.state.doc.textBetween(ctxFrom, from, '\n') : '';
    setAiBusy(true);
    setAiError(null);
    setAiSuggestion(null);
    setAiSelRange(null);
    try {
      const data = await api<ContentAiSuggestionDto>(`/projects/${projectId}/content/${editingId}/ai`, {
        method: 'POST',
        body: {
          action,
          selection: needsSel ? selText : null,
          tone,
          context: context || null,
          keyword: live.current.targetKeyword.trim() || null,
        },
      });
      setAiSuggestion(data);
      if (needsSel) setAiSelRange({ from, to });
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  };

  const applyAi = () => {
    const s = aiSuggestion;
    if (!s || !editor) return;
    const html = textToBlocksHtml(s.text);
    if (s.action === 'generate_section') {
      editor
        .chain()
        .focus()
        .insertContentAt(editor.state.doc.content.size, html, { updateSelection: false })
        .run();
    } else if (aiSelRange) {
      editor.chain().focus().insertContentAt({ from: aiSelRange.from, to: aiSelRange.to }, html).run();
    }
    setAiSuggestion(null);
    setAiSelRange(null);
  };

  const rejectAi = () => {
    setAiSuggestion(null);
    setAiSelRange(null);
  };

  if (!creating && editingId === null) {
    return (
      <div>
        <h1>Content Studio</h1>
        <p className="sub">
          Structured articles edited as a Tiptap document. content_json is the source of truth; HTML and the outline
          are rendered from it — no raw HTML editing.
        </p>
        {canEdit && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newTitle.trim()) return;
              startNew();
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

  // Read-only workspace for viewers: rendered server-side HTML, never an
  // editable Tiptap instance hidden behind a read-only flag.
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
        {viewerSeo && (
          <div style={{ maxWidth: 460, marginBottom: 16 }}>
            <SeoPanel
              result={viewerSeo}
              editable={false}
              targetKeyword={d.target_keyword ?? ''}
              metaTitle={d.meta_title ?? ''}
              metaDescription={d.meta_description ?? ''}
            />
          </div>
        )}
        {d.content_html ? (
          <div className="card">
            <div className="article-body" dangerouslySetInnerHTML={{ __html: d.content_html }} />
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

  if (!canEdit) {
    return (
      <div>
        <p className="sub">Loading…</p>
      </div>
    );
  }

  const initialDoc = creating ? tiptapEmptyDoc() : asTipDoc(detail.data?.content_json);

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <button className="btn sm" onClick={goList}>
          ← Back to list
        </button>
      </div>

      {err && <div className="banner error">{err}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <ContentEditorHeader
        title={title}
        onTitleChange={(t) => setTitle(t)}
        status={status}
        onStatusChange={changeStatus}
        saveState={auto.status}
        wordCount={wordCount}
        slug={slug}
        savedAt={savedAt}
        canEdit={canEdit}
        canDelete={canDelete}
        busy={auto.status === 'saving'}
        onSaveNow={auto.saveNow}
        onDelete={() => void remove(editingId)}
      />

      {auto.status === 'failed' && (
        <div className="banner error" style={{ marginTop: 8 }}>
          Could not save your changes. Check your connection and press Save to retry.
        </div>
      )}

      {aiError && (
        <div className="banner error" style={{ marginTop: 8 }}>
          {aiError}
        </div>
      )}

      <div className="ce-grid">
        <div className="ce-main">
          <div className="rt-shell">
            <ContentToolbar
              editor={editor}
              ai={
                editingId
                  ? {
                      configured: aiConfigured,
                      busy: aiBusy,
                      hasSelection,
                      onAction: runAi,
                    }
                  : undefined
              }
            />
            <RichTextEditor
              key={`${editingId ?? 'new'}-${loadSeq}`}
              ref={editorRef}
              initialDoc={initialDoc}
              onDocChange={(next) => setDoc(next)}
              onEditor={(e) => setEditor(e)}
            />
          </div>
          {aiBusy && (
            <p className="muted" style={{ marginTop: 8 }}>
              Generating with AI… suggestions are previewed before they touch the document.
            </p>
          )}
          {aiSuggestion && (
            <div style={{ marginTop: 12 }}>
              <ContentAiPanel suggestion={aiSuggestion} onApply={applyAi} onReject={rejectAi} />
            </div>
          )}
        </div>
        <aside className="ce-aside">
          <SeoPanel
            result={seo}
            editable={canEdit}
            targetKeyword={targetKeyword}
            metaTitle={metaTitle}
            metaDescription={metaDescription}
            onKeywordChange={setTargetKeyword}
            onMetaTitleChange={setMetaTitle}
            onMetaDescriptionChange={setMetaDescription}
          />
          <ContentOutline items={outline} onSelect={(i) => editorRef.current?.selectHeading(i)} />
        </aside>
      </div>
    </div>
  );
}
