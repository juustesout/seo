/**
 * Shared workspace document session for the unified three-mode shell (R5.3).
 *
 * The shell owns exactly one of these. It carries the authoritative document
 * identity + save barrier (`useDocumentSession`), the identity-keyed loader
 * (`useDocumentLoad`), the canonical lifecycle projection (`documentLifecycle`)
 * and the single `useAutosave`, plus the live document fields those modes edit.
 * Modes read it through `useWorkspaceSession`; none of them keeps a second copy.
 *
 * This is the R5.2 session ownership lifted out of the former `views/Content.tsx`
 * wrapper (removed in R5.4.7) so the Editor, Composer and Designer modes of the
 * workspace share one document. It creates no new identity, revision or autosave:
 * it only relocates the owners.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import { asTipDoc, tiptapEmptyDoc, type TipDoc } from '@seo/contracts';
import { api } from '../lib/api';
import { useAsync } from '../lib/ui';
import { useAutosave } from '../components/content/useAutosave';
import { canonicalFromEditorDocument } from '../components/content/editorDraft';
import { workspaceRevisionOf, workspaceSnapshotOf } from '../components/content/documentRevision';
import {
  documentLifecycle,
  useDocumentLoad,
  useDocumentSession,
  type DocumentLoad,
  type DocumentLifecycle,
  type DocumentSession,
  type DocumentSessionValue,
} from '../components/content/session';

export interface ContentRow {
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

export type DetailRow = ContentRow & { content_json: unknown; content_html: string | null; outline: unknown };

/** The editable fields autosave mirrors and persists. */
export interface LiveWorkspace {
  title: string;
  status: string;
  doc: TipDoc;
  targetKeyword: string;
  metaTitle: string;
  metaDescription: string;
}

const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export interface WorkspaceSessionValue {
  projectId: string;
  role: string;
  canEdit: boolean;
  canDelete: boolean;
  session: DocumentSession;
  detail: DocumentLoad<DetailRow>;
  lifecycle: DocumentLifecycle;
  auto: ReturnType<typeof useAutosave>;
  live: MutableRefObject<LiveWorkspace>;
  /** Boundary key whose document has been seeded into the live fields. */
  seededKey: string | null;

  title: string;
  setTitle: Dispatch<SetStateAction<string>>;
  status: string;
  setStatus: Dispatch<SetStateAction<string>>;
  doc: TipDoc;
  setDoc: Dispatch<SetStateAction<TipDoc>>;
  targetKeyword: string;
  setTargetKeyword: Dispatch<SetStateAction<string>>;
  metaTitle: string;
  setMetaTitle: Dispatch<SetStateAction<string>>;
  metaDescription: string;
  setMetaDescription: Dispatch<SetStateAction<string>>;
  slug: string | null;
  savedAt: string | null;
  changeStatus: (next: string) => void;

  list: ReturnType<typeof useAsync<{ content: ContentRow[]; total: number }>>;
  refresh: number;
  setRefresh: Dispatch<SetStateAction<number>>;
  newTitle: string;
  setNewTitle: Dispatch<SetStateAction<string>>;
  notice: string | null;
  setNotice: Dispatch<SetStateAction<string | null>>;
  err: string | null;
  setErr: Dispatch<SetStateAction<string | null>>;
  remove: (id: string | null) => Promise<void>;

  sessionValue: DocumentSessionValue;
}

/** Owns the shared document session for the unified workspace shell. */
export function useWorkspaceSession({ projectId, role = 'viewer' }: { projectId: string; role?: string }): WorkspaceSessionValue {
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

  // Live document state, shared by every mode.
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('draft');
  const [doc, setDoc] = useState<TipDoc>(() => tiptapEmptyDoc());
  const [targetKeyword, setTargetKeyword] = useState('');
  const [metaTitle, setMetaTitle] = useState('');
  const [metaDescription, setMetaDescription] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [seededKey, setSeededKey] = useState<string | null>(null);

  const detail = useDocumentLoad<DetailRow>(editingId, (id) => api(`/projects/${projectId}/content/${id}`));

  // The one document lifecycle. It is a pure projection of the session identity
  // and the identity-keyed loader, so readiness is not tracked anywhere else.
  const lifecycle = documentLifecycle(session.identity, detail);

  // Synchronous mirror of the current workspace so autosave always reads the
  // latest document/title/status, even mid-render or right after a state update.
  const live = useRef<LiveWorkspace>({ title, status, doc, targetKeyword, metaTitle, metaDescription });
  live.current = { title, status, doc, targetKeyword, metaTitle, metaDescription };

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
    if (!editingId && row) {
      // First save of a new document: adopt the persisted identity without
      // creating a new logical boundary, and mark the id as already loaded so
      // the loader does not refetch through the loading screen (R5.2.9).
      session.adoptDocumentId(row.id);
      detail.adopt(row.id);
    }
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
    setSeededKey(session.boundary);
    auto.setBaseline(workspaceRevisionOf(live.current));
  }, [editingId, detail.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seed a brand-new document so opening the editor never auto-creates a row.
  useEffect(() => {
    if (!creating) return;
    const next = tiptapEmptyDoc();
    live.current = { ...live.current, doc: next };
    setDoc(next);
    setSeededKey(session.boundary);
    auto.setBaseline(workspaceRevisionOf(live.current));
  }, [creating]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return {
    projectId,
    role,
    canEdit,
    canDelete,
    session,
    detail,
    lifecycle,
    auto,
    live,
    seededKey,
    title,
    setTitle,
    status,
    setStatus,
    doc,
    setDoc,
    targetKeyword,
    setTargetKeyword,
    metaTitle,
    setMetaTitle,
    metaDescription,
    setMetaDescription,
    slug,
    savedAt,
    changeStatus,
    list,
    refresh,
    setRefresh,
    newTitle,
    setNewTitle,
    notice,
    setNotice,
    err,
    setErr,
    remove,
    sessionValue,
  };
}

const WorkspaceSessionContext = createContext<WorkspaceSessionValue | null>(null);

export function WorkspaceSessionProvider({ value, children }: { value: WorkspaceSessionValue; children: ReactNode }) {
  return <WorkspaceSessionContext.Provider value={value}>{children}</WorkspaceSessionContext.Provider>;
}

/** The shared workspace session, required. Throws when a consumer is mis-nested. */
export function useWorkspaceSessionContext(): WorkspaceSessionValue {
  const value = useContext(WorkspaceSessionContext);
  if (!value) throw new Error('useWorkspaceSessionContext must be used within a ProjectWorkspaceShell');
  return value;
}
