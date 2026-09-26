/**
 * Product-level workspace shell (R5.3, ADR `docs/r5.1-workspace-decisions.md`).
 *
 * Owns the shared workspace infrastructure for every mode - the one document
 * session (identity, loader, lifecycle, autosave, live document fields), the
 * shared document-scoped workspace state and the shared workspace chrome - then
 * dispatches exactly one active mode from the canonical `:mode`:
 *
 *   editor   -> EditorMode   (owns all editor infrastructure)
 *   composer -> ComposerMode (Composer boundary, owns no shared lifecycle)
 *   designer -> Designer     (compatibility body)
 *
 * Editor-specific infrastructure (Tiptap instance, editor context/selection
 * providers, editor keymap, editor AI state and the editor-coupled assistant)
 * lives in `EditorMode`, so Composer/Designer never mount it. The shell keeps no
 * editor instance and no second session/autosave/lifecycle.
 */
import { useCallback, useMemo, useState } from 'react';
import { isCanonicalDocumentEmpty, type CanonicalDocument } from '@seo/contracts';
import { DocumentSessionProvider, type SwitchResult } from '../components/content/session';
import { WorkspaceStateProvider, useDocumentScopedState } from '../components/content/workspace/workspaceState';
import { documentRevisionOf } from '../components/content/documentRevision';
import { canonicalFromEditorDocument } from '../components/content/editorDraft';
import { Designer } from '../views/Designer';
import { ComposerMode } from './ComposerMode';
import { pendingCompositionOf, type CompositionApplyOutcome, type PendingComposition } from './CompositionApplyBridge';
import { EditorMode } from './EditorMode';
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
 * chrome state (preview/rail) resets with the document boundary. It owns the
 * shared document-switch actions and renders exactly one active mode.
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
  const { session, lifecycle, canEdit } = ws;

  // Document-scoped workspace UI state (R5.2.7): the header toggles reset with
  // the document, on the same boundary.
  const [previewOpen, setPreviewOpen] = useDocumentScopedState(false);
  const [railOpen, setRailOpen] = useDocumentScopedState(false);

  // R5.4.3.2: a composed page staged for the open document. It survives the
  // composer -> editor mode switch (this shell stays mounted) and is consumed by
  // the editor through the single external-document mutation path once ready.
  const [pendingComposition, setPendingComposition] = useState<PendingComposition | null>(null);

  // A composition may replace the open document in place only while it is empty:
  // a whole-document replacement must never destroy existing content.
  const canApplyComposition = useMemo(() => {
    if (!canEdit || lifecycle.status !== 'ready') return false;
    try {
      return isCanonicalDocumentEmpty(canonicalFromEditorDocument(ws.doc));
    } catch {
      return false;
    }
  }, [canEdit, lifecycle.status, ws.doc]);

  const activeMode = normalizeWorkspaceMode(mode);
  // The shared header is meaningful only while the editor mode owns a ready,
  // editable document; Composer/Designer are still legacy bodies with their own
  // headers (R5.4/R5.5 converge them onto the shared document).
  const showChrome = activeMode === 'editor' && lifecycle.status === 'ready' && canEdit;

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

  /**
   * Composer handoff: open the draft Composer just created through the shared
   * session, so it becomes the one canonical active document (crossing the save
   * barrier like any other switch), then move to the editor mode. Composer never
   * keeps a document id of its own.
   */
  const openInEditor = (contentId: string) => {
    void switchTo(session.requestDocumentSwitch(contentId), () => onModeChange?.('editor'));
  };

  /**
   * R5.4.3.2: apply a composed page to the currently open document. It stages
   * the composed `CanonicalDocument` as a `DesignerProposal` bound to the open
   * document's revision and boundary, then moves to the editor mode, where the
   * bridge applies it through `applyExternalDocument`. No document switch and no
   * `/content` create: the open document is replaced through the single editor
   * mutation path. Only an empty document is a valid target.
   */
  const applyComposition = (document: CanonicalDocument) => {
    if (!canEdit || lifecycle.status !== 'ready') return;
    let empty = false;
    try {
      empty = isCanonicalDocumentEmpty(canonicalFromEditorDocument(ws.live.current.doc));
    } catch {
      empty = false;
    }
    if (!empty) {
      ws.setErr('A composition can only be applied to an empty document. Use "Open in Editor" to create a new draft.');
      return;
    }
    ws.setErr(null);
    ws.setNotice(null);
    setPendingComposition(pendingCompositionOf(document, documentRevisionOf(ws.live.current.doc), session.boundary));
    onModeChange?.('editor');
  };

  const onCompositionResult = (outcome: CompositionApplyOutcome) => {
    setPendingComposition(null);
    if (outcome.status === 'applied') {
      ws.setNotice('The composition was applied to this document. Autosave will persist it.');
      ws.setErr(null);
      return;
    }
    ws.setNotice(null);
    ws.setErr(
      outcome.status === 'stale-document'
        ? 'The document changed before the composition could be applied. It was left unchanged.'
        : 'The composition could not be applied to this document.',
    );
  };

  return (
    <div className="grid gap-4">
      <WorkspaceModeSwitcher mode={activeMode} onChange={onModeChange} />
      {showChrome && (
        <WorkspaceChrome
          previewOpen={previewOpen}
          onTogglePreview={() => setPreviewOpen((value) => !value)}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((value) => !value)}
          onBack={goList}
          onOpenCalendar={onOpenCalendar}
          onOpenPublications={onOpenPublications}
        />
      )}
      {activeMode === 'editor' && (
        <EditorMode
          previewOpen={previewOpen}
          railOpen={railOpen}
          onClosePreview={() => setPreviewOpen(false)}
          onRevealInsertion={() => setRailOpen(true)}
          initialContentId={initialContentId}
          open={open}
          startNew={startNew}
          goList={goList}
          onOpenCalendar={onOpenCalendar}
          pendingComposition={pendingComposition}
          onCompositionResult={onCompositionResult}
        />
      )}
      {activeMode === 'composer' && (
        <ComposerMode
          onOpenEditor={openInEditor}
          onApplyToDocument={applyComposition}
          canApplyToDocument={canApplyComposition}
        />
      )}
      {activeMode === 'designer' && <Designer projectId={projectId} role={role} />}
    </div>
  );
}
