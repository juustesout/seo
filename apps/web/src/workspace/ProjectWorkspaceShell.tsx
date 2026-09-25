/**
 * Product-level workspace shell (R5.3, ADR `docs/r5.1-workspace-decisions.md`).
 *
 * Owns the one shared document session (identity, loader, lifecycle, autosave
 * and live document fields) for every mode, the workspace chrome
 * (`WorkspaceChrome`: document header + save status + assistant entry) and the
 * editor instance + editor context providers that the chrome and the editor
 * canvas both read. It does not own mode-specific tools or workflows: the
 * active mode renders its own body.
 *
 * `EditorWorkspace` and `EditorShell` stay editor-specific; this shell is the
 * product frame around them.
 */
import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { ProjectAiStatusDto } from '@seo/contracts';
import { api } from '../lib/api';
import { DocumentSessionProvider, type SwitchResult } from '../components/content/session';
import { WorkspaceStateProvider, useDocumentScopedState } from '../components/content/workspace/workspaceState';
import { EditorContextProvider } from '../components/content/editor/EditorContext';
import { EditorSelectionProvider } from '../components/content/editor/EditorSelectionContext';
import { Compose } from '../views/Compose';
import { Designer } from '../views/Designer';
import { EditorView } from '../views/EditorView';
import { WorkspaceChrome } from './WorkspaceChrome';
import { WorkspaceModeSwitcher, normalizeWorkspaceMode, type WorkspaceMode } from './WorkspaceModeSwitcher';
import { WorkspaceSessionProvider, useWorkspaceSession, useWorkspaceSessionContext } from './workspaceSession';

export interface ProjectWorkspaceShellProps {
  projectId: string;
  role?: string;
  /** Active mode; defaults to editor. */
  mode?: WorkspaceMode;
  /** Deep link to a document to open once the shell mounts. */
  initialContentId?: string | null;
  /** Sync a mode change to the URL. When absent the switcher is read-only. */
  onModeChange?: (mode: WorkspaceMode) => void;
  onOpenCalendar?: () => void;
  onOpenPublications?: (contentId: string) => void;
}

export function ProjectWorkspaceShell({
  projectId,
  role = 'viewer',
  mode = 'editor',
  initialContentId = null,
  onModeChange,
  onOpenCalendar,
  onOpenPublications,
}: ProjectWorkspaceShellProps) {
  const ws = useWorkspaceSession({ projectId, role });

  return (
    <WorkspaceSessionProvider value={ws}>
      <DocumentSessionProvider value={ws.sessionValue}>
        <WorkspaceStateProvider documentKey={ws.session.boundary}>
          <WorkspaceBody
            projectId={projectId}
            role={role}
            mode={mode}
            initialContentId={initialContentId}
            onModeChange={onModeChange}
            onOpenCalendar={onOpenCalendar}
            onOpenPublications={onOpenPublications}
          />
        </WorkspaceStateProvider>
      </DocumentSessionProvider>
    </WorkspaceSessionProvider>
  );
}

/**
 * Inner shell body, rendered under the workspace scope so its document-scoped
 * chrome state (preview/rail/assistant) resets with the document boundary. It
 * also owns the editor instance and the editor context providers so the shell
 * can place the chrome and the canvas in the same context.
 */
function WorkspaceBody({
  projectId,
  role,
  mode,
  initialContentId,
  onModeChange,
  onOpenCalendar,
  onOpenPublications,
}: Required<Pick<ProjectWorkspaceShellProps, 'projectId' | 'role' | 'mode'>> & {
  initialContentId: string | null;
  onModeChange?: (mode: WorkspaceMode) => void;
  onOpenCalendar?: () => void;
  onOpenPublications?: (contentId: string) => void;
}) {
  const ws = useWorkspaceSessionContext();
  const { session, lifecycle, auto, canEdit } = ws;

  const [editor, setEditor] = useState<Editor | null>(null);
  // A draft created by the Composer mode opens in the Editor mode without a
  // route change. The document itself stays in the one shared session.
  const [composedDraftId, setComposedDraftId] = useState<string | null>(null);

  // Editor AI availability (project-level BYOK/env), read once per document so
  // both the chrome and the editor canvas share the same answer.
  const [aiConfigured, setAiConfigured] = useState(false);
  // Inline AI in-flight signal reported by the editor, used only for the
  // assistant slot's status text. The operations stay owned by the editor.
  const [assistantBusy, setAssistantBusy] = useState(false);

  // Document-scoped workspace UI state (R5.2.7): the chrome toggles and the
  // assistant open state reset with the document, on the same boundary.
  const [previewOpen, setPreviewOpen] = useDocumentScopedState(false);
  const [railOpen, setRailOpen] = useDocumentScopedState(false);
  const [assistantOpen, setAssistantOpen] = useDocumentScopedState(false);

  const editingId = session.identity.documentId;
  const activeMode = normalizeWorkspaceMode(mode);
  const editorContentId = composedDraftId ?? initialContentId;
  const showChrome = activeMode === 'editor' && lifecycle.status === 'ready' && canEdit;

  useEffect(() => {
    let alive = true;
    if (lifecycle.status !== 'ready' || !canEdit || !editingId) {
      setAiConfigured(false);
      return;
    }
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
  const switchTo = async (pending: Promise<SwitchResult>, after?: () => void): Promise<boolean> => {
    const result = await pending;
    if (result.status !== 'switched') {
      ws.setErr(
        result.reason === 'save_in_progress'
          ? 'A document switch is already in progress.'
          : 'Could not switch documents because your latest changes were not saved. Retry the save, then try again.',
      );
      return false;
    }
    ws.setErr(null);
    ws.setNotice(null);
    after?.();
    return true;
  };

  const open = (id: string) => {
    void switchTo(session.requestDocumentSwitch(id));
  };

  const startNew = () => {
    const nextTitle = ws.newTitle;
    void switchTo(session.requestNewDocument(), () => {
      ws.setTitle(nextTitle);
      ws.setNewTitle('');
    });
  };

  const goList = () => {
    void switchTo(session.requestCloseDocument());
  };

  // Workspace keymap: save, assistant focus and preview/assistant dismissal.
  // Active only while the editor mode owns the document, matching the previous
  // editor-workspace scope.
  useEffect(() => {
    if (activeMode !== 'editor' || lifecycle.status !== 'ready' || !canEdit) return;
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        auto.saveNow();
        return;
      }
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setAssistantOpen(true);
        return;
      }
      if (event.key === 'Escape') {
        // Escape only dismisses the Agent while focus is inside it, so it never
        // steals the key from the document or the composition surface.
        const slot = document.getElementById('inline-assistant');
        if (assistantOpen && slot?.contains(document.activeElement)) {
          setAssistantOpen(false);
          return;
        }
        setPreviewOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeMode, lifecycle.status, canEdit, auto, assistantOpen, setAssistantOpen, setPreviewOpen]);

  return (
    <EditorSelectionProvider editor={editor} documentId={editingId}>
      <EditorContextProvider
        projectId={projectId}
        contentId={editingId}
        ready={lifecycle.status === 'ready'}
        doc={ws.doc}
        dirty={auto.dirty}
        editor={editor}
      >
        <div className="grid gap-4">
          <WorkspaceModeSwitcher mode={activeMode} onChange={onModeChange} />
          {showChrome && (
            <WorkspaceChrome
              previewOpen={previewOpen}
              onTogglePreview={() => setPreviewOpen((value) => !value)}
              railOpen={railOpen}
              onToggleRail={() => setRailOpen((value) => !value)}
              assistantOpen={assistantOpen}
              onAssistantOpenChange={setAssistantOpen}
              assistantConfigured={aiConfigured}
              assistantBusy={assistantBusy}
              onRevealInsertion={() => setRailOpen(true)}
              onBack={goList}
              onOpenCalendar={onOpenCalendar}
              onOpenPublications={onOpenPublications}
            />
          )}
          {activeMode === 'editor' && (
            <EditorView
              editor={editor}
              onEditor={setEditor}
              aiConfigured={aiConfigured}
              onAssistantBusyChange={setAssistantBusy}
              preview={previewOpen}
              railOpen={railOpen}
              initialContentId={editorContentId}
              open={open}
              startNew={startNew}
              goList={goList}
              onOpenCalendar={onOpenCalendar}
            />
          )}
          {activeMode === 'composer' && (
            <Compose
              projectId={projectId}
              role={role}
              onOpenEditor={(contentId) => {
                setComposedDraftId(contentId);
                onModeChange?.('editor');
              }}
            />
          )}
          {activeMode === 'designer' && <Designer projectId={projectId} role={role} />}
        </div>
      </EditorContextProvider>
    </EditorSelectionProvider>
  );
}
