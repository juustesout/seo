/**
 * Composer mode boundary (R5.4.1).
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
 * It mounts no editor infrastructure (no Tiptap, `EditorContextProvider`,
 * `EditorSelectionProvider`, editor keymap or editor AI state), so the R5.3.3
 * isolation guarantee is preserved.
 */
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
}

export function ComposerMode({ onOpenEditor }: ComposerModeProps) {
  const { projectId, role } = useWorkspaceSessionContext();

  return <Compose projectId={projectId} role={role} onOpenEditor={onOpenEditor} />;
}
