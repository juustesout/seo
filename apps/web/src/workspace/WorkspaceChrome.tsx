/**
 * Workspace-level chrome for the unified shell (R5.3.2).
 *
 * Rendered by `ProjectWorkspaceShell` above the active mode, it owns the three
 * elements that belong to the workspace rather than to a single mode:
 *
 * - `DocumentHeader`: the document title/status and its action cluster. The
 *   save indicator/status lives inside this header as the `document-save-state`
 *   badge, so it moves with it; the save-failure banner is rendered here too.
 * - the assistant entry (`InlineAssistantSlot` + `EmbeddedAgentEntry`).
 *
 * It introduces no state of its own: the document session comes from
 * `useWorkspaceSessionContext`, and the small open/toggle booleans come from the
 * shell (document-scoped). This keeps exactly one session, autosave, lifecycle
 * and assistant owner.
 */
import { docWordCount } from '@seo/contracts';
import { DocumentHeader } from '../components/content/workspace/DocumentHeader';
import { EmbeddedAgentEntry } from '../components/content/workspace/EmbeddedAgentEntry';
import { InlineAssistantSlot } from '../components/content/workspace/InlineAssistantSlot';
import { useWorkspaceSessionContext } from './workspaceSession';

export interface WorkspaceChromeProps {
  previewOpen: boolean;
  onTogglePreview: () => void;
  railOpen: boolean;
  onToggleRail: () => void;
  assistantOpen: boolean;
  onAssistantOpenChange: (open: boolean) => void;
  assistantConfigured: boolean;
  assistantBusy: boolean;
  onRevealInsertion: () => void;
  onBack: () => void;
  onOpenCalendar?: () => void;
  onOpenPublications?: (contentId: string) => void;
}

export function WorkspaceChrome({
  previewOpen,
  onTogglePreview,
  railOpen,
  onToggleRail,
  assistantOpen,
  onAssistantOpenChange,
  assistantConfigured,
  assistantBusy,
  onRevealInsertion,
  onBack,
  onOpenCalendar,
  onOpenPublications,
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
      />
      {auto.status === 'failed' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Could not save your changes. Check your connection and press Save to retry.
        </div>
      )}
      <InlineAssistantSlot configured={assistantConfigured} busy={assistantBusy}>
        <EmbeddedAgentEntry
          open={assistantOpen}
          onOpenChange={onAssistantOpenChange}
          canEdit={canEdit}
          configured={assistantConfigured}
          onSaveNow={auto.saveNow}
          onRevealInsertion={onRevealInsertion}
        />
      </InlineAssistantSlot>
    </div>
  );
}
