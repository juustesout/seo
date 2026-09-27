/**
 * Shared workspace chrome for the unified shell (R5.3.2/R5.3.3).
 *
 * Rendered by `ProjectWorkspaceShell` above the active mode, it owns the
 * elements that belong to the workspace rather than to a single mode:
 *
 * - `DocumentHeader`: the document title/status and its action cluster. The
 *   save indicator/status lives inside this header as the `document-save-state`
 *   badge, so it moves with it; the save-failure banner is rendered here too.
 *
 * The editor-coupled assistant entry does NOT live here: it needs
 * `useEditorContext`/`useEditorSelection`, so it is rendered by `EditorMode`
 * only while the editor mode is active (R5.3.3). This keeps Composer/Designer
 * from paying for editor infrastructure.
 *
 * It introduces no state of its own: the document session comes from
 * `useWorkspaceSessionContext`, and the preview/rail toggles come from the
 * shell (document-scoped).
 */
import { docWordCount } from '@seo/contracts';
import { DocumentHeader } from '../components/content/workspace/DocumentHeader';
import type { WorkspaceSurface } from '../components/content/workspace/workspaceContext';
import type { WorkspaceProjectInfo } from './projectInfo';
import { useWorkspaceSessionContext } from './workspaceSession';

export interface WorkspaceChromeProps {
  previewOpen: boolean;
  onTogglePreview: () => void;
  railOpen: boolean;
  onToggleRail: () => void;
  /** Intelligence rail (outline/SEO/media/insights) toggle, on-demand (R5.6.2). */
  toolsOpen: boolean;
  onToggleTools: () => void;
  onBack: () => void;
  onOpenCalendar?: () => void;
  onOpenPublications?: (contentId: string) => void;
  /** Canonical project context for the document header (R5.9). */
  project?: WorkspaceProjectInfo;
  /** Navigate to the canonical project administration surfaces (R5.9). */
  onOpenSettings?: () => void;
  onOpenIntegrations?: () => void;
  /**
   * The active workspace surface (R5.8), passed straight to the document header.
   * It decides which editor-canvas controls render: the header stays present in
   * every mode while editor-only controls are hidden outside the editor. Defaults
   * to the editable canvas.
   */
  surface?: WorkspaceSurface;
}

export function WorkspaceChrome({
  previewOpen,
  onTogglePreview,
  railOpen,
  onToggleRail,
  toolsOpen,
  onToggleTools,
  onBack,
  onOpenCalendar,
  onOpenPublications,
  project,
  onOpenSettings,
  onOpenIntegrations,
  surface = 'canvas',
}: WorkspaceChromeProps) {
  const {
    canEdit,
    canDelete,
    session,
    auto,
    doc,
    title,
    setTitle,
    status,
    changeStatus,
    slug,
    savedAt,
    remove,
  } = useWorkspaceSessionContext();

  const editingId = session.identity.documentId;
  const wordCount = docWordCount(doc);

  return (
    <div className="grid gap-3">
      <DocumentHeader
        title={title}
        onTitleChange={setTitle}
        status={status}
        onStatusChange={changeStatus}
        saveState={auto.status}
        wordCount={wordCount}
        slug={slug}
        savedAt={savedAt}
        canEdit={canEdit}
        canDelete={canDelete}
        busy={auto.status === 'saving'}
        onSaveNow={auto.saveNow}
        onDelete={() => void remove(editingId)}
        onBack={onBack}
        onViewPublications={editingId && onOpenPublications ? () => onOpenPublications(editingId) : undefined}
        onOpenCalendar={onOpenCalendar}
        previewOpen={previewOpen}
        onTogglePreview={onTogglePreview}
        railOpen={railOpen}
        onToggleRail={onToggleRail}
        toolsOpen={toolsOpen}
        onToggleTools={onToggleTools}
        project={project}
        onOpenSettings={onOpenSettings}
        onOpenIntegrations={onOpenIntegrations}
        surface={surface}
      />
      {auto.status === 'failed' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Could not save your changes. Check your connection and press Save to retry.
        </div>
      )}
    </div>
  );
}
