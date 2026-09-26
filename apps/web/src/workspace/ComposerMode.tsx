/**
 * Composer mode boundary (R5.4.1 / R5.4.2).
 *
 * The shell dispatches exactly one active mode; this is the composer branch and
 * the architectural seam between the shared workspace/session and the existing
 * Composer surface. It owns no document identity, loader, save state or
 * lifecycle of its own:
 *
 * - project identity and role come from the shared `WorkspaceSessionValue`
 *   (`useWorkspaceSessionContext`), not from a Composer-local variable;
 * - the canonical active document identity stays in the shared session
 *   (`useDocumentSession`); the only document interaction is the handoff, which
 *   routes the created draft through the shell (see `onOpenEditor`);
 * - the composition workflow (brief, format, phase, plan, preview, open/close
 *   flags) stays owned by `Compose`, because it is not document/session state.
 *
 * R5.4.2 hardens the handoff: `beginHandoff` captures the shared document
 * boundary when the create task starts (through the existing
 * `useOperationBoundary`), and also treats leaving the composer mode as
 * invalidation, so a late creation result cannot switch the workspace to an
 * obsolete draft. The workspace error (e.g. a failed save barrier) is surfaced
 * here because Composer does not render the shared document chrome.
 *
 * It mounts no editor infrastructure (no Tiptap, `EditorContextProvider`,
 * `EditorSelectionProvider`, editor keymap or editor AI state), so the R5.3.3
 * isolation guarantee is preserved.
 *
 * R5.4.6: the workspace is the single chrome/navigation layer. This boundary
 * hides Composer's own page header (`showHeader={false}`) because the shell's
 * document header already anchors the current document, and it reports whether a
 * review is open so the shell can refuse a mode switch that would silently
 * discard it. Neither change gives Composer a second document identity.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { CanonicalDocument, CompositionOperationBatch } from '@seo/contracts';
import { useOperationBoundary } from '../components/content/session';
import { Compose } from '../views/Compose';
import { useWorkspaceSessionContext } from './workspaceSession';

export interface ComposerModeProps {
  /**
   * Opens a draft produced by the Composer through the shared session. The
   * shell supplies this: it crosses the save barrier and switches to the editor
   * mode, so the new draft becomes the one canonical active document instead of
   * a Composer-local id.
   */
  onOpenEditor: (contentId: string) => void;
  /**
   * Applies a composed page to the currently open document (R5.4.3.2). Supplied
   * by the shell, which stages the composed document and moves to the editor
   * mode; the editor then performs the single external-document replacement.
   */
  onApplyToDocument?: (document: CanonicalDocument) => void;
  /** True while the open shared document is an eligible (empty) apply target. */
  canApplyToDocument?: boolean;
  /**
   * Stages the Composer operation batch produced from a generated composition
   * for the currently open non-empty document (R5.4.4). Supplied by the shell.
   */
  onAppendToDocument?: (batch: CompositionOperationBatch) => void;
  /** True while the open shared document is an eligible (non-empty) append target. */
  canAppendToDocument?: boolean;
  /**
   * Reports whether Composer currently has an open review (R5.4.6). The shell
   * uses it as a navigation hold so a mode switch cannot silently discard the
   * review; no review data crosses this boundary.
   */
  onReviewOpenChange?: (open: boolean) => void;
}

export function ComposerMode({
  onOpenEditor,
  onApplyToDocument,
  canApplyToDocument = false,
  onAppendToDocument,
  canAppendToDocument = false,
  onReviewOpenChange,
}: ComposerModeProps) {
  const { projectId, role, session, err } = useWorkspaceSessionContext();

  // Guard for the draft-creation handoff. The workspace boundary is captured
  // when the task starts; leaving the composer mode (this boundary component
  // unmounting) also invalidates it, since a composer that is no longer active
  // must not perform a late handoff.
  const beginOperation = useOperationBoundary(session.boundary);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const beginHandoff = useCallback(() => {
    const operation = beginOperation();
    return { isStale: () => !mounted.current || operation.isStale() };
  }, [beginOperation]);

  return (
    <div className="grid gap-3">
      {err && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}
      <Compose
        projectId={projectId}
        role={role}
        onOpenEditor={onOpenEditor}
        beginHandoff={beginHandoff}
        onApplyToDocument={onApplyToDocument}
        canApplyToDocument={canApplyToDocument}
        onAppendToDocument={onAppendToDocument}
        canAppendToDocument={canAppendToDocument}
        onReviewOpenChange={onReviewOpenChange}
        showHeader={false}
      />
    </div>
  );
}
