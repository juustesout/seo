/**
 * Content Studio workspace (project nav "Content").
 *
 * Structured content is the source of truth: the editor works on a Tiptap
 * `content_json` document plus metadata (title, status, target keyword, meta
 * title/description). `content_html` is only ever a server-side render of that
 * JSON and is never hand-edited. Autosave freezes whole-document snapshots
 * (see useAutosave) and PATCHes the row; media is referenced by a stable
 * `mediaId` pointing at the project library - never embedded as a data URL.
 *
 * Role handling is explicit: viewers get a read-only render of `content_html`
 * (no editable Tiptap hidden behind a flag), editors can edit/save/autosave
 * and flip status, admins/owners can additionally delete. In-editor AI is
 * review-before-apply and never auto-applies to the document.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { ArrowLeft } from 'lucide-react';
import {
  asTipDoc,
  docHeadings,
  docWordCount,
  evaluateSeo,
  tiptapEmptyDoc,
  type ContentAiAction,
  type ContentAiEditOperation,
  type ContentAiEditResponseDto,
  type ContentAiSuggestionDto,
  type ContentOutlineItem,
  type ProjectAiStatusDto,
  type SeoResult,
  type TipDoc,
} from '@seo/contracts';
import { api } from '../lib/api';
import { useAsync, fmtDate, Empty } from '../lib/ui';
import type { RichTextEditorHandle } from '../components/content/RichTextEditor';
import { CollapsibleSection, EditorWorkspace, WorkspaceStateProvider } from '../components/content/workspace';
import { ContentOutline } from '../components/content/ContentOutline';
import { SeoPanel } from '../components/content/SeoPanel';
import { AgentControls } from '../components/content/AgentControls';
import { MediaPanel } from '../components/content/MediaPanel';
import { ContentAiPanel } from '../components/content/ContentAiPanel';
import { ContentAiEditPanel } from '../components/content/ContentAiEditPanel';
import {
  applyAiEditToEditor,
  readEditorSelection,
  type AiEditProposal,
} from '../components/content/contentAiEditFlow';
import { WriterPanel } from '../components/content/WriterPanel';
import { KnowledgePanel } from '../components/content/KnowledgePanel';
import { IntelligencePanel } from '../components/content/IntelligencePanel';
import { AI_EDIT_OPERATION_LABELS, textToBlocksHtml } from '../components/content/contentAi';
import { canonicalFromEditorDocument } from '../components/content/editorDraft';
import { useAutosave } from '../components/content/useAutosave';
import { workspaceRevisionOf, workspaceSnapshotOf } from '../components/content/documentRevision';
import {
  DocumentSessionProvider,
  documentLifecycle,
  documentScopeKey,
  editorHistoryKey,
  useDocumentLoad,
  useDocumentSession,
  type DocumentSessionValue,
  type SwitchResult,
} from '../components/content/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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

/**
 * Orchestrates the Content Studio list, the editor workspace and the read-only
 * viewer render.
 *
 * Props: `projectId` scopes every API call; `role` is the current user's role
 * in this project (viewer/editor/admin/owner) and drives canEdit/canDelete;
 * `onOpenCalendar` and `onOpenPublications` deep-link to the Calendar and to
 * this article's publication history. Workspace state lives here so the list,
 * viewer and editor share one load/refresh path, and the current
 * document/metadata is mirrored into a ref for autosave.
 */
export function Content({
  projectId,
  role = 'viewer',
  initialContentId = null,
  onOpenCalendar,
  onOpenPublications,
}: {
  projectId: string;
  role?: string;
  /** Deep link (e.g. from Compose) to open one draft on mount. */
  initialContentId?: string | null;
  onOpenCalendar?: () => void;
  onOpenPublications?: (contentId: string) => void;
}) {
  const rank = ROLE_RANK[role] ?? 0;
  const canEdit = rank >= 1;
  const canDelete = rank >= 2;

  const [refresh, setRefresh] = useState(0);
  const list = useAsync<{ content: ContentRow[]; total: number }>(
    () => api(`/projects/${projectId}/content?limit=300`),
    [projectId, refresh],
  );

  const [newTitle, setNewTitle] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Shared session boundary: the single authoritative document identity. Every
  // switch crosses the save barrier (see useDocumentSession) so dirty content is
  // flushed before the current document is abandoned.
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const session = useDocumentSession({ flush: () => flushRef.current() });
  const editingId = session.identity.documentId;
  const creating = session.identity.creating;

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
  const [useKnowledge, setUseKnowledge] = useState(true);

  // Cosmos AI editor: one structured, selection-scoped edit path (preview-only
  // until the user applies it). Kept separate from the legacy plain-text action.
  const [aiEditBusy, setAiEditBusy] = useState(false);
  const [aiEditError, setAiEditError] = useState<string | null>(null);
  const [aiEditProposal, setAiEditProposal] = useState<AiEditProposal | null>(null);

  // Writer panel (W6): a separate, explicit writer flow for the open article.
  // Kept as its own open/close flag so the panel survives parent re-renders
  // and only ever targets the persisted row being edited (never a new draft).
  const [writerOpen, setWriterOpen] = useState(false);

  const detail = useDocumentLoad<DetailRow>(editingId, (id) => api(`/projects/${projectId}/content/${id}`));

  // The one document lifecycle. It is a pure projection of the session identity
  // and the identity-keyed loader, so readiness is not tracked anywhere else.
  const lifecycle = documentLifecycle(session.identity, detail);

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

  // One canonical revision for the open workspace (see documentRevision): the
  // autosave equality/dirty check and the debounce key use it, while the JSON
  // snapshot stays the exact payload persisted.
  const workspaceRevision = useMemo(
    () => workspaceRevisionOf({ doc, title, status, targetKeyword, metaTitle, metaDescription }),
    [title, status, doc, targetKeyword, metaTitle, metaDescription],
  );

  // Persist one snapshot: PATCH the row being edited or POST a brand-new row,
  // then adopt the server id (first save of a new document) and nudge the list.
  const commit = async (snapshot: string) => {
    const parsed = JSON.parse(snapshot) as { t: string; s: string; d: TipDoc; k: string; mt: string; md: string };
    // Stage 8E.6 Phase 1 reverse bridge: the edited document must convert back to
    // a valid CanonicalDocument before it is persisted. content_json stays Tiptap.
    canonicalFromEditorDocument(parsed.d);
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
    if (!editingId && row) session.adoptDocumentId(row.id);
    if (row) {
      setSavedAt(row.updated_at ?? new Date().toISOString());
      setSlug(row.slug ?? null);
    }
    window.setTimeout(() => setRefresh((x) => x + 1), 250);
  };

  const auto = useAutosave({
    enabled: lifecycle.status === 'ready' && canEdit,
    delayMs: 1600,
    makeSnapshot: () => workspaceSnapshotOf(live.current),
    makeRevision: () => workspaceRevisionOf(live.current),
    snapshotKey: workspaceRevision,
    persist: commit,
  });

  // The session barrier flushes through the live autosave instance.
  flushRef.current = auto.flush;

  // The one canonical session value consumers read: authoritative identity plus
  // the lifecycle state the loader and autosave already own.
  const sessionValue = useMemo<DocumentSessionValue>(
    () => ({
      projectId,
      documentId: session.identity.documentId,
      isNew: session.identity.creating,
      hasDocument: session.hasDocument,
      lifecycle,
      dirty: auto.dirty,
      saveState: auto.status,
      requestDocumentSwitch: session.requestDocumentSwitch,
      requestNewDocument: session.requestNewDocument,
      requestCloseDocument: session.requestCloseDocument,
      adoptDocumentId: session.adoptDocumentId,
      discardDocument: session.discardDocument,
    }),
    // `lifecycle` is a fresh object each render; the primitive fields it is
    // derived from are the stable inputs.
    [
      projectId,
      session.identity,
      session.hasDocument,
      session.requestDocumentSwitch,
      session.requestNewDocument,
      session.requestCloseDocument,
      session.adoptDocumentId,
      session.discardDocument,
      lifecycle.status,
      lifecycle.error,
      auto.dirty,
      auto.status,
    ], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Seed an existing row into the workspace once the active document has loaded.
  // The identity-keyed loader clears its payload on a switch, so this runs once
  // per loaded document without a separate "already seeded" flag.
  useEffect(() => {
    if (!editingId) return;
    const row = detail.data;
    if (!row || row.id !== editingId) return;
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
    auto.setBaseline(workspaceRevisionOf(live.current));
  }, [editingId, detail.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seed a brand-new document so opening the editor never auto-creates a row.
  useEffect(() => {
    if (!creating) return;
    const next = tiptapEmptyDoc();
    live.current = { ...live.current, doc: next };
    setDoc(next);
    auto.setBaseline(workspaceRevisionOf(live.current));
  }, [creating]); // eslint-disable-line react-hooks/exhaustive-deps

  // AI provider availability (account BYOK + env) for this project.
  useEffect(() => {
    let alive = true;
    if (lifecycle.status !== 'ready' || !canEdit || !editingId) return;
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
  }, [projectId, lifecycle.status, canEdit, editingId]);

  /**
   * Cross the shared save barrier, then apply the destination state. Nothing
   * about the current document is reset until the barrier reports `switched`,
   * so a failed save leaves the editor, selection and dirty state untouched.
   */
  const switchTo = async (pending: Promise<SwitchResult>, after?: () => void) => {
    const result = await pending;
    if (result.status !== 'switched') {
      setErr(
        result.reason === 'save_in_progress'
          ? 'A document switch is already in progress.'
          : 'Could not switch documents because your latest changes were not saved. Retry the save, then try again.',
      );
      return;
    }
    setErr(null);
    setNotice(null);
    resetAi();
    after?.();
  };

  const open = (id: string) => void switchTo(session.requestDocumentSwitch(id));

  // Deep link from Compose: open the freshly created draft exactly once. The
  // regular list flow keeps `initialContentId` null and is untouched.
  const initialOpenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialContentId || initialOpenRef.current === initialContentId) return;
    initialOpenRef.current = initialContentId;
    open(initialContentId);
  }, [initialContentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const startNew = () => {
    const nextTitle = newTitle;
    void switchTo(session.requestNewDocument(), () => {
      setTitle(nextTitle);
      setNewTitle('');
    });
  };

  const goList = () => void switchTo(session.requestCloseDocument());

  const resetAi = () => {
    setAiBusy(false);
    setAiError(null);
    setAiSuggestion(null);
    setAiSelRange(null);
    setAiEditBusy(false);
    setAiEditError(null);
    setAiEditProposal(null);
    setWriterOpen(false);
  };

  const changeStatus = (next: string) => {
    if (!canEdit || lifecycle.status !== 'ready' || next === live.current.status) return;
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
        // The row is gone; there is nothing to flush, only to forget.
        session.discardDocument();
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
          use_knowledge: useKnowledge,
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

  // --- Cosmos AI editor (structured replace_selection, preview-before-apply) ---

  const runAiEdit = async (operation: ContentAiEditOperation, instruction?: string) => {
    if (!editor || !editingId || aiEditBusy) return;
    const selection = readEditorSelection(editor);
    if (!selection) {
      setAiEditError('Select the text you want to edit first.');
      return;
    }
    const { from, to, text } = selection;
    setAiEditBusy(true);
    setAiEditError(null);
    setAiEditProposal(null);
    try {
      const data = await api<ContentAiEditResponseDto>(`/projects/${projectId}/content/${editingId}/ai/edit`, {
        method: 'POST',
        body: { operation, selection: { from, to }, text, instruction: instruction ?? null },
      });
      setAiEditProposal({ ...data, range: { from, to }, requested: operation });
    } catch (e) {
      setAiEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiEditBusy(false);
    }
  };

  // Applying is a normal editor transaction over the selected range only, so
  // autosave picks it up and Undo stays available. The document is never
  // replaced wholesale.
  const applyAiEdit = () => {
    if (!applyAiEditToEditor(editor, aiEditProposal)) return;
    setAiEditProposal(null);
  };

  const rejectAiEdit = () => {
    setAiEditProposal(null);
  };

  if (lifecycle.status === 'idle') {
    return (
      <div className="grid gap-5">
        <PageHeader
          title="Content Studio"
          description="Structured articles edited as a Tiptap document. content_json is the source of truth; HTML and the outline are rendered from it — no raw HTML editing."
          actions={
            <>
              {canEdit ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newTitle.trim()) return;
                    startNew();
                  }}
                >
                  <Input
                    type="text"
                    placeholder="New article title…"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    className="w-[320px]"
                  />
                  <Button disabled={!newTitle.trim()}>Start article</Button>
                </form>
              ) : (
                <p className="text-sm text-muted-foreground">You have read-only access to this project's content.</p>
              )}
              {onOpenCalendar && (
                <Button variant="outline" onClick={onOpenCalendar} title="View and manage publication schedules">
                  Schedule calendar
                </Button>
              )}
            </>
          }
        />
        {notice && (
          <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{notice}</div>
        )}
        {err && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {err}
          </div>
        )}
        {list.data && list.data.content.length === 0 && (
          <Empty>No content yet{canEdit ? '. Start your first article above.' : '.'}</Empty>
        )}
        {list.data && list.data.content.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Target keyword</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Updated</TableHead>
                {canDelete && <TableHead>Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.content.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => open(c.id)}>
                  <TableCell>
                    <div>{c.title}</div>
                    <div className="font-mono text-xs text-muted-foreground">{c.slug ?? '—'}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.status === 'published' ? 'success' : 'outline'}>{c.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.target_keyword ?? '—'}</TableCell>
                  <TableCell className="tabular-nums">{c.seo_score != null ? Math.round(c.seo_score) : '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{fmtDate(c.updated_at)}</TableCell>
                  {canDelete && (
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(c.id);
                        }}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    );
  }

  // Loading and load failure are explicit lifecycle states. Rendering with
  // stale data would pair the new document identity with the previous
  // document's content and selection, which the editor context must never
  // expose; so the workspace is not mounted until the active document is ready.
  if (lifecycle.status === 'loading') {
    return (
      <div className="grid gap-5">
        <PageHeader title="Content Studio" description="Loading…" />
      </div>
    );
  }

  if (lifecycle.status === 'error') {
    return (
      <div className="grid gap-4">
        <PageHeader title="Content Studio" description="Could not load this document." />
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {lifecycle.error}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={detail.reload}>
            Retry
          </Button>
          <Button variant="outline" size="sm" onClick={goList}>
            <ArrowLeft /> Back to list
          </Button>
        </div>
      </div>
    );
  }

  // Read-only workspace for viewers: rendered server-side HTML, never an
  // editable Tiptap instance hidden behind a read-only flag.
  if (!canEdit) {
    const d = detail.data;
    if (!d) {
      return (
        <div className="grid gap-5">
          <PageHeader title="Content Studio" description="Loading…" />
        </div>
      );
    }
    return (
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="outline" size="sm" onClick={goList}>
            <ArrowLeft /> Back
          </Button>
          <h1 className="text-xl font-semibold tracking-tight">{d.title}</h1>
          <Badge variant={d.status === 'published' ? 'success' : 'outline'}>{d.status}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {d.updated_at ? `Updated ${fmtDate(d.updated_at)}` : ''}
          {d.target_keyword ? ` · Target keyword: ${d.target_keyword}` : ''}
        </p>
        {viewerSeo && (
          <div className="max-w-[460px]">
            <SeoPanel
              result={viewerSeo}
              editable={false}
              targetKeyword={d.target_keyword ?? ''}
              metaTitle={d.meta_title ?? ''}
              metaDescription={d.meta_description ?? ''}
            />
          </div>
        )}
        {editingId && (
          <div className="max-w-[460px]">
            <IntelligencePanel projectId={projectId} contentId={editingId} />
          </div>
        )}
        {d.content_html ? (
          <Card>
            <CardContent>
              <div className="article-body" dangerouslySetInnerHTML={{ __html: d.content_html }} />
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">This document has no content yet.</p>
        )}
        <p className="text-xs text-muted-foreground">Read-only view — you do not have edit access to this project.</p>
      </div>
    );
  }

  const initialDoc = creating ? tiptapEmptyDoc() : asTipDoc(detail.data?.content_json);

  return (
    <DocumentSessionProvider value={sessionValue}>
      <WorkspaceStateProvider documentKey={documentScopeKey(session.identity, session.generation)}>
        <EditorWorkspace
          doc={doc}
          editor={editor}
          header={{
            title,
            onTitleChange: setTitle,
            status,
            onStatusChange: changeStatus,
            saveState: auto.status,
            wordCount,
            slug,
            savedAt,
            canEdit,
            canDelete,
            busy: auto.status === 'saving',
            onSaveNow: auto.saveNow,
            onDelete: () => void remove(editingId),
            onBack: goList,
            onViewPublications: editingId && onOpenPublications ? () => onOpenPublications(editingId) : undefined,
            onOpenCalendar,
          }}
          toolbarAi={
            editingId ? { configured: aiConfigured, busy: aiBusy, onAction: runAi } : undefined
          }
          writing={{
            editorKey: editorHistoryKey(session.identity, session.generation),
            editorRef,
            initialDoc,
            onDocChange: setDoc,
            onEditor: setEditor,
            aiActions:
              editingId && canEdit
                ? {
                    configured: aiConfigured,
                    busy: aiEditBusy,
                    onAction: (operation, instruction) => void runAiEdit(operation, instruction),
                  }
                : undefined,
          }}
          assistant={{ configured: aiConfigured, busy: aiBusy || aiEditBusy }}
          banners={
            <>
              {err && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {err}
                </div>
              )}
              {notice && (
                <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{notice}</div>
              )}
              {auto.status === 'failed' && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  Could not save your changes. Check your connection and press Save to retry.
                </div>
              )}
              {aiError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {aiError}
                </div>
              )}
            </>
          }
          review={
            <>
              {aiSuggestion && (
                <div className="mt-3">
                  <ContentAiPanel suggestion={aiSuggestion} onApply={applyAi} onReject={rejectAi} />
                </div>
              )}
              {aiEditProposal && (
                <div className="mt-3">
                  <ContentAiEditPanel
                    proposal={aiEditProposal}
                    operationLabel={AI_EDIT_OPERATION_LABELS[aiEditProposal.requested]}
                    onApply={applyAiEdit}
                    onReject={rejectAiEdit}
                  />
                </div>
              )}
              {aiEditError && (
                <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {aiEditError}
                </div>
              )}
            </>
          }
          rail={{
            outline,
            onSelectHeading: (index) => editorRef.current?.selectHeading(index),
            seo: {
              result: seo,
              targetKeyword,
              metaTitle,
              metaDescription,
              onKeywordChange: setTargetKeyword,
              onMetaTitleChange: setMetaTitle,
              onMetaDescriptionChange: setMetaDescription,
            },
            media: editor ? { projectId, editor, canEdit, canDelete } : undefined,
            intelligence: editingId ? { projectId, contentId: editingId } : undefined,
          }}
          secondary={
            <CollapsibleSection title="Writer and draft tools" testId="editor-secondary-tools">
              <div className="grid gap-3">
                {aiConfigured && (
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" checked={useKnowledge} onChange={(e) => setUseKnowledge(e.target.checked)} />
                    <span>Include this project's knowledge as context when available</span>
                  </label>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" disabled={!editingId} onClick={() => setWriterOpen((v) => !v)}>
                    {writerOpen ? 'Close writer' : 'Writer'}
                  </Button>
                  {!editingId && (
                    <span className="text-xs text-muted-foreground">Save this draft first to run the writer on it.</span>
                  )}
                  {writerOpen && editingId && (
                    <span className="text-xs text-muted-foreground">
                      Runs the approved writer flow against this article's saved context; results are previewed, never saved
                      automatically.
                    </span>
                  )}
                </div>
                {writerOpen && editingId && (
                  <WriterPanel
                    projectId={projectId}
                    contentId={editingId}
                    defaultTopic={title}
                    defaultKeyword={targetKeyword.trim() || undefined}
                  />
                )}
                {editingId && (
                  <AgentControls
                    projectId={projectId}
                    contentId={editingId}
                    canEdit={canEdit}
                    aiConfigured={aiConfigured}
                    onOpenDraft={(id) => {
                      setRefresh((x) => x + 1);
                      open(id);
                    }}
                  />
                )}
              </div>
            </CollapsibleSection>
          }
          knowledge={
            <CollapsibleSection title="Project knowledge" testId="editor-knowledge">
              <KnowledgePanel projectId={projectId} canEdit={canEdit} />
            </CollapsibleSection>
          }
        />
      </WorkspaceStateProvider>
    </DocumentSessionProvider>
  );
}
