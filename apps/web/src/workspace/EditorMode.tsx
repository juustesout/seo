/**
 * Editor mode boundary (R5.3.3).
 *
 * The shell dispatches exactly one active mode. This component is the editor
 * branch and owns every piece of editor-specific infrastructure so that
 * `Compose` and `Designer` never mount it:
 *
 * - the live Tiptap editor instance
 * - `EditorSelectionProvider` (the single selection owner)
 * - `EditorContextProvider`
 * - the editor keymap (save / assistant / escape)
 * - editor-specific AI state (project AI status, inline AI busy signal)
 * - the editor-coupled assistant entry
 *
 * It owns no document/session state: identity, lifecycle, autosave and the save
 * barrier stay in `ProjectWorkspaceShell` and are read through
 * `useWorkspaceSessionContext`. `EditorView` remains the editor-mode
 * presentation boundary.
 */
import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { ProjectAiStatusDto } from '@seo/contracts';
import { api } from '../lib/api';
import { useDocumentScopedState } from '../components/content/workspace/workspaceState';
import { EditorContextProvider } from '../components/content/editor/EditorContext';
import { EditorSelectionProvider } from '../components/content/editor/EditorSelectionContext';
import { EmbeddedAgentEntry } from '../components/content/workspace/EmbeddedAgentEntry';
import { InlineAssistantSlot } from '../components/content/workspace/InlineAssistantSlot';
import { EditorView } from '../views/EditorView';
import { CompositionApplyBridge, type CompositionApplyOutcome, type PendingComposition } from './CompositionApplyBridge';
import { useWorkspaceSessionContext } from './workspaceSession';

export interface EditorModeProps {
  previewOpen: boolean;
  railOpen: boolean;
  /** Closes the canvas preview (Escape when the assistant is not focused). */
  onClosePreview: () => void;
  /** Opens the insert rail, e.g. after the agent applies an insertion. */
  onRevealInsertion: () => void;
  /** Deep link (e.g. from Compose) to open one draft on mount. */
  initialContentId: string | null;
  open: (id: string) => void;
  startNew: () => void;
  goList: () => void;
  onOpenCalendar?: () => void;
  /** A composed page staged by the shell, applied once this editor is ready. */
  pendingComposition?: PendingComposition | null;
  onCompositionResult?: (outcome: CompositionApplyOutcome) => void;
}

export function EditorMode({
  previewOpen,
  railOpen,
  onClosePreview,
  onRevealInsertion,
  initialContentId,
  open,
  startNew,
  goList,
  onOpenCalendar,
  pendingComposition = null,
  onCompositionResult,
}: EditorModeProps) {
  const ws = useWorkspaceSessionContext();
  const { projectId, session, lifecycle, auto, canEdit } = ws;

  const [editor, setEditor] = useState<Editor | null>(null);
  // Editor-specific AI state: project AI availability and the inline AI busy
  // signal shown in the assistant slot. Both are only meaningful for the editor.
  const [aiConfigured, setAiConfigured] = useState(false);
  const [assistantBusy, setAssistantBusy] = useState(false);
  // Document-scoped assistant open state (R5.2.7): resets with the document.
  const [assistantOpen, setAssistantOpen] = useDocumentScopedState(false);

  const editingId = session.identity.documentId;

  // AI provider availability (account BYOK + env) for this project.
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

  // Editor keymap: save, assistant focus and preview/assistant dismissal. Only
  // registered while this editor mode is mounted and owns a ready document.
  useEffect(() => {
    if (lifecycle.status !== 'ready' || !canEdit) return;
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
        onClosePreview();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lifecycle.status, canEdit, auto, assistantOpen, setAssistantOpen, onClosePreview]);

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
        {pendingComposition && onCompositionResult && (
          <CompositionApplyBridge
            pending={pendingComposition}
            ready={editor !== null}
            onResult={onCompositionResult}
          />
        )}
        <div className="grid gap-3">
          <InlineAssistantSlot configured={aiConfigured} busy={assistantBusy}>
            <EmbeddedAgentEntry
              open={assistantOpen}
              onOpenChange={setAssistantOpen}
              canEdit={canEdit}
              configured={aiConfigured}
              onSaveNow={auto.saveNow}
              onRevealInsertion={onRevealInsertion}
            />
          </InlineAssistantSlot>
          <EditorView
            editor={editor}
            onEditor={setEditor}
            aiConfigured={aiConfigured}
            onAssistantBusyChange={setAssistantBusy}
            preview={previewOpen}
            railOpen={railOpen}
            initialContentId={initialContentId}
            open={open}
            startNew={startNew}
            goList={goList}
            onOpenCalendar={onOpenCalendar}
          />
        </div>
      </EditorContextProvider>
    </EditorSelectionProvider>
  );
}
