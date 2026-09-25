/**
 * Compatibility entry for the former Content Studio view.
 *
 * The editor is now the Editor mode of the unified workspace shell
 * (`ProjectWorkspaceShell`). This wrapper preserves the old `Content` props and
 * lets the mode switcher drive the shell from local state; new code should
 * render `ProjectWorkspaceShell` directly and sync the mode to the route.
 */
import { useState } from 'react';
import { ProjectWorkspaceShell, type WorkspaceMode } from '../workspace';

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
  const [mode, setMode] = useState<WorkspaceMode>('editor');
  return (
    <ProjectWorkspaceShell
      projectId={projectId}
      role={role}
      mode={mode}
      initialContentId={initialContentId}
      onModeChange={setMode}
      onOpenCalendar={onOpenCalendar}
      onOpenPublications={onOpenPublications}
    />
  );
}
