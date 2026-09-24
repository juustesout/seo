/**
 * Outer editor workspace shell (R1).
 *
 * Owns the product layout that used to be a flat stack in the view: one
 * document header, one merged contextual toolbar, the writing canvas with a
 * reserved inline AI place, a segmented intelligence rail, and demoted
 * collapsible secondary sections. It also owns the workspace keymap (save,
 * assistant focus, escape) and the preview toggle.
 *
 * It deliberately adds no route and no backend behaviour: every action is
 * delegated to handlers the view already owned. The active document identity,
 * ready/dirty state all come from the shared document session context rather
 * than a prop-drilled copy.
 */
import { useEffect, type ReactNode, type Ref } from 'react';
import type { Editor } from '@tiptap/react';
import type { TipDoc } from '@seo/contracts';
import { RichTextEditor, type RichTextEditorHandle } from '../RichTextEditor';
import type { EditorAiActions } from '../EditorAiBubbleMenu';
import type { ContentAiToolbar } from '../ContentToolbar';
import { EditorSelectionProvider, useEditorSelection } from '../editor/EditorSelectionContext';
import { EditorContextProvider } from '../editor/EditorContext';
import { snapshotHasSelection } from '../editor/selection';
import { useRequiredDocumentSession } from '../session';
import { useDocumentScopedState } from './workspaceState';
import { EditorShell } from '../editor/EditorShell';
import { ContextualToolbar } from './ContextualToolbar';
import { DocumentHeader, type DocumentHeaderProps } from './DocumentHeader';
import { EmbeddedAgentEntry } from './EmbeddedAgentEntry';
import { InlineAssistantSlot } from './InlineAssistantSlot';
import { PreviewPane } from './PreviewPane';
import { IntelligenceRail, type IntelligenceRailProps } from './IntelligenceRail';

export interface EditorWorkspaceProps {
  /** Live document, used only for the preview render. */
  doc: TipDoc;
  editor: Editor | null;
  header: Omit<DocumentHeaderProps, 'previewOpen' | 'onTogglePreview' | 'railOpen' | 'onToggleRail'>;
  toolbarAi?: ContentAiToolbar;
  writing: {
    editorKey: string;
    editorRef: Ref<RichTextEditorHandle>;
    initialDoc: TipDoc;
    onDocChange: (doc: TipDoc) => void;
    onEditor: (editor: Editor | null) => void;
    aiActions?: EditorAiActions;
  };
  assistant: { configured: boolean; busy: boolean; pollMs?: number };
  banners?: ReactNode;
  review?: ReactNode;
  rail: IntelligenceRailProps;
  secondary?: ReactNode;
  knowledge?: ReactNode;
}

/**
 * Merged toolbar that derives AI selection availability from the canonical
 * selection boundary instead of the view tracking it separately (R5.2.4).
 */
function WorkspaceToolbar({ editor, ai }: { editor: Editor | null; ai?: ContentAiToolbar }) {
  const shared = useEditorSelection();
  const resolved = ai ? { ...ai, hasSelection: shared ? snapshotHasSelection(shared.selection) : false } : undefined;
  return <ContextualToolbar editor={editor} ai={resolved} />;
}

export function EditorWorkspace({
  doc,
  editor,
  header,
  toolbarAi,
  writing,
  assistant,
  banners,
  review,
  rail,
  secondary,
  knowledge,
}: EditorWorkspaceProps) {
  const session = useRequiredDocumentSession();
  // Document-scoped view state (R5.2.7): keyed to the session document
  // boundary, so a new document starts from these defaults instead of
  // inheriting the previous document's preview/rail/assistant state.
  const [preview, setPreview] = useDocumentScopedState(false);
  const [railOpen, setRailOpen] = useDocumentScopedState(false);
  const [assistantOpen, setAssistantOpen] = useDocumentScopedState(false);

  const onSaveNow = header.onSaveNow;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSaveNow();
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
        setPreview(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSaveNow, assistantOpen]);

  return (
    <EditorSelectionProvider editor={editor} documentId={session.documentId}>
      <EditorContextProvider
        projectId={session.projectId}
        contentId={session.documentId}
        ready={session.lifecycle.status === 'ready'}
        dirty={session.dirty}
        doc={doc}
        editor={editor}
      >
        <div className="grid gap-3" data-testid="editor-workspace">
          {banners}
          <DocumentHeader
            {...header}
            previewOpen={preview}
            onTogglePreview={() => setPreview((value) => !value)}
            railOpen={railOpen}
            onToggleRail={() => setRailOpen((value) => !value)}
          />
          <div className="mt-1 grid grid-cols-1 items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0">
              <div className={preview ? 'hidden' : undefined}>
                <EditorShell
                  editor={editor}
                  showRail={railOpen}
                  toolbar={<WorkspaceToolbar editor={editor} ai={toolbarAi} />}
                >
                  <RichTextEditor
                    key={writing.editorKey}
                    ref={writing.editorRef}
                    initialDoc={writing.initialDoc}
                    onDocChange={writing.onDocChange}
                    onEditor={writing.onEditor}
                    aiActions={writing.aiActions}
                  />
                </EditorShell>
              </div>
              {preview && <PreviewPane doc={doc} />}
              <InlineAssistantSlot configured={assistant.configured} busy={assistant.busy}>
                <EmbeddedAgentEntry
                  open={assistantOpen}
                  onOpenChange={setAssistantOpen}
                  canEdit={header.canEdit}
                  configured={assistant.configured}
                  onSaveNow={onSaveNow}
                  pollMs={assistant.pollMs}
                  onRevealInsertion={() => setRailOpen(true)}
                />
              </InlineAssistantSlot>
              {review}
            </div>
            <IntelligenceRail {...rail} />
          </div>
          {secondary}
          {knowledge}
        </div>
      </EditorContextProvider>
    </EditorSelectionProvider>
  );
}
