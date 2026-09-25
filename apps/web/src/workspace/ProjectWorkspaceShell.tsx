/**
 * Product-level workspace shell (R5.3, ADR `docs/r5.1-workspace-decisions.md`).
 *
 * Owns the one shared document session (identity, loader, lifecycle, autosave
 * and live document fields) for every mode, plus the mode switcher. It does not
 * own mode-specific tools or workflows: the active mode renders its own body.
 *
 * `EditorWorkspace` and `EditorShell` stay editor-specific; this shell is the
 * product frame around them.
 */
import { useState } from 'react';
import { DocumentSessionProvider } from '../components/content/session';
import { WorkspaceStateProvider } from '../components/content/workspace/workspaceState';
import { Compose } from '../views/Compose';
import { Designer } from '../views/Designer';
import { EditorView } from '../views/EditorView';
import { WorkspaceModeSwitcher, normalizeWorkspaceMode, type WorkspaceMode } from './WorkspaceModeSwitcher';
import { WorkspaceSessionProvider, useWorkspaceSession } from './workspaceSession';

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
  // A draft created by the Composer mode opens in the Editor mode without a
  // route change. The document itself stays in the one shared session.
  const [composedDraftId, setComposedDraftId] = useState<string | null>(null);

  const activeMode = normalizeWorkspaceMode(mode);
  const editorContentId = composedDraftId ?? initialContentId;

  return (
    <WorkspaceSessionProvider value={ws}>
      <DocumentSessionProvider value={ws.sessionValue}>
        <WorkspaceStateProvider documentKey={ws.session.boundary}>
          <div className="grid gap-4">
            <WorkspaceModeSwitcher mode={activeMode} onChange={onModeChange} />
            {activeMode === 'editor' && (
              <EditorView
                initialContentId={editorContentId}
                onOpenCalendar={onOpenCalendar}
                onOpenPublications={onOpenPublications}
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
        </WorkspaceStateProvider>
      </DocumentSessionProvider>
    </WorkspaceSessionProvider>
  );
}
