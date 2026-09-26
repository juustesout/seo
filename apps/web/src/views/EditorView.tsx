/**
 * Editor mode of the unified workspace shell (R5.3.1).
 *
 * This is the R5.2 Content Studio editor orchestration, extracted from the
 * former `views/Content.tsx` wrapper (removed in R5.4.7). It no longer owns the
 * document session, loader, lifecycle, autosave or the live document fields - the
 * shell owns those and this view reads them through
 * `useWorkspaceSessionContext`. Since R5.3.2 the
 * workspace chrome (document header, save status, assistant entry) and the
 * editor instance + editor context providers also live in the shell; this view
 * owns only editor-specific concerns: the list, inline AI state, the writer
 * panel and the canvas.
 *
 * Structured content is the source of truth: the editor works on a Tiptap
 * `content_json` document plus metadata (title, status, target keyword, meta
 * title/description). `content_html` is only ever a server-side render of that
 * JSON and is never hand-edited. Media is referenced by a stable `mediaId`
 * pointing at the project library - never embedded as a data URL.
 *
 * Role handling is explicit: viewers get a read-only render of `content_html`
 * (no editable Tiptap hidden behind a flag), editors can edit/save/autosave and
 * flip status, admins/owners can additionally delete. In-editor AI is
 * review-before-apply and never auto-applies to the document.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { ArrowLeft } from 'lucide-react';
import {
  asTipDoc,
  docHeadings,
  evaluateSeo,
  tiptapEmptyDoc,
  type ContentAiAction,
  type ContentAiEditOperation,
  type ContentAiEditResponseDto,
  type ContentAiSuggestionDto,
  type ContentOutlineItem,
  type SeoResult,
  type TipDoc,
} from '@seo/contracts';
import { api } from '../lib/api';
import { fmtDate, Empty } from '../lib/ui';
import type { RichTextEditorHandle } from '../components/content/RichTextEditor';
import { CollapsibleSection, EditorWorkspace } from '../components/content/workspace';
import { SeoPanel } from '../components/content/SeoPanel';
import { AgentControls } from '../components/content/AgentControls';
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
import { useOperationBoundary } from '../components/content/session';
import { useWorkspaceSessionContext } from '../workspace/workspaceSession';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface EditorViewProps {
  /** Live Tiptap instance, owned by the shell so the chrome can share it. */
  editor: Editor | null;
  onEditor: (editor: Editor | null) => void;
  /** Project-level AI availability, owned by the shell. */
  aiConfigured: boolean;
  /** Reports the combined inline AI busy signal up to the shell chrome. */
  onAssistantBusyChange: (busy: boolean) => void;
  /** Shell-owned canvas preview toggle. */
  preview: boolean;
  /** Shell-owned insert rail toggle. */
  railOpen: boolean;
  /** Deep link (e.g. from Compose) to open one draft on mount. */
  initialContentId?: string | null;
  open: (id: string) => void;
  startNew: () => void;
  goList: () => void;
  onOpenCalendar?: () => void;
}

export function EditorView({
  editor,
  onEditor,
  aiConfigured,
  onAssistantBusyChange,
  preview,
  railOpen,
  initialContentId = null,
  open,
  startNew,
  goList,
  onOpenCalendar,
}: EditorViewProps) {
  const ws = useWorkspaceSessionContext();
  const {
    projectId,
    canEdit,
    canDelete,
    session,
    detail,
    lifecycle,
    live,
    seededKey,
    title,
    doc,
    setDoc,
    targetKeyword,
    setTargetKeyword,
    metaTitle,
    setMetaTitle,
    metaDescription,
    setMetaDescription,
    list,
    setRefresh,
    newTitle,
    setNewTitle,
    notice,
    err,
    remove,
  } = ws;

  const editingId = session.identity.documentId;
  const creating = session.identity.creating;

  const editorRef = useRef<RichTextEditorHandle | null>(null);

  // In-editor AI action state (review-before-apply; never auto-applies).
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

  // Guards async inline AI operations against applying a late result to the
  // wrong document. It reads the live session boundary (identity + generation,
  // frozen across an id adoption), so a switch/new/close invalidates a capture
  // while an adoption does not (R5.2.9).
  const beginOperation = useOperationBoundary(session.boundary);

  const outline: ContentOutlineItem[] = useMemo(() => docHeadings(doc), [doc]);
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

  // Reset editor-local AI state when the active document boundary moves (the
  // shell owns the switch now, so this replaces the reset that used to happen
  // inside the view's switch helper).
  useEffect(() => {
    resetAi();
  }, [session.boundary]); // eslint-disable-line react-hooks/exhaustive-deps

  // Report the combined inline AI busy signal to the shell chrome's assistant
  // slot. The operations themselves stay owned here.
  useEffect(() => {
    onAssistantBusyChange(aiBusy || aiEditBusy);
    return () => onAssistantBusyChange(false);
  }, [aiBusy, aiEditBusy, onAssistantBusyChange]);

  // Deep link from Compose: open the freshly created draft exactly once. The
  // regular list flow keeps `initialContentId` null and is untouched.
  const initialOpenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialContentId || initialOpenRef.current === initialContentId) return;
    initialOpenRef.current = initialContentId;
    open(initialContentId);
  }, [initialContentId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Capture the active document boundary: a late suggestion for a document
    // the user has left must never populate the panels of the active one.
    const operation = beginOperation();
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
      if (operation.isStale()) return;
      setAiSuggestion(data);
      if (needsSel) setAiSelRange({ from, to });
    } catch (e) {
      if (operation.isStale()) return;
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!operation.isStale()) setAiBusy(false);
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
    // Same document-boundary guard as `runAi`: a stale structured edit must not
    // populate (or, later, mutate through) the active document.
    const boundary = beginOperation();
    setAiEditBusy(true);
    setAiEditError(null);
    setAiEditProposal(null);
    try {
      const data = await api<ContentAiEditResponseDto>(`/projects/${projectId}/content/${editingId}/ai/edit`, {
        method: 'POST',
        body: { operation, selection: { from, to }, text, instruction: instruction ?? null },
      });
      if (boundary.isStale()) return;
      setAiEditProposal({ ...data, range: { from, to }, requested: operation });
    } catch (e) {
      if (boundary.isStale()) return;
      setAiEditError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!boundary.isStale()) setAiEditBusy(false);
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

  // Seed the editor from the live document once the shell has seeded it (so a
  // mode remount keeps unsaved edits), and from the loader payload on the first
  // ready render of a newly opened document (so the editor never mounts with
  // the previous document's content).
  const initialDoc =
    seededKey === session.boundary ? doc : creating ? tiptapEmptyDoc() : asTipDoc(detail.data?.content_json);

  return (
    <EditorWorkspace
      doc={doc}
      editor={editor}
      preview={preview}
      railOpen={railOpen}
      toolbarAi={editingId ? { configured: aiConfigured, busy: aiBusy, onAction: runAi } : undefined}
      writing={{
        editorKey: session.boundary,
        editorRef,
        initialDoc,
        onDocChange: setDoc,
        onEditor,
        aiActions:
          editingId && canEdit
            ? {
                configured: aiConfigured,
                busy: aiEditBusy,
                onAction: (operation, instruction) => void runAiEdit(operation, instruction),
              }
            : undefined,
      }}
      banners={
        <>
          {err && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {err}
            </div>
          )}
          {notice && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{notice}</div>}
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
              {!editingId && <span className="text-xs text-muted-foreground">Save this draft first to run the writer on it.</span>}
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
  );
}
