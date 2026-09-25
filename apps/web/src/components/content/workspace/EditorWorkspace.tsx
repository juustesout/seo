/**
 * Editor canvas workspace (R1, slimmed in R5.3.2).
 *
 * Owns the product layout inside the editor mode: the merged contextual toolbar,
 * the writing canvas with a reserved inline AI place controlled by the shell,
 * a segmented intelligence rail, and demoted collapsible secondary sections.
 *
 * Since R5.3.2 the workspace chrome (document header, save status, assistant
 * entry) lives in the shell, and the editor/selection context providers are
 * owned by the shell too, so this component renders the canvas only and reads
 * the shared contexts they publish. It deliberately adds no route and no
 * backend behaviour: every action is delegated to handlers the view owns.
 */
import type { ReactNode, Ref } from 'react';
import type { Editor } from '@tiptap/react';
import type { TipDoc } from '@seo/contracts';
import { RichTextEditor, type RichTextEditorHandle } from '../RichTextEditor';
import type { EditorAiActions } from '../EditorAiBubbleMenu';
import type { ContentAiToolbar } from '../ContentToolbar';
import { useEditorSelection } from '../editor/EditorSelectionContext';
import { snapshotHasSelection } from '../editor/selection';
import { EditorShell } from '../editor/EditorShell';
import { ContextualToolbar } from './ContextualToolbar';
import { PreviewPane } from './PreviewPane';
import { IntelligenceRail, type IntelligenceRailProps } from './IntelligenceRail';

export interface EditorWorkspaceProps {
  /** Live document, used only for the preview render. */
  doc: TipDoc;
  editor: Editor | null;
  /** Shell-owned preview toggle: hides the canvas and shows the rendered doc. */
  preview: boolean;
  /** Shell-owned insert rail toggle. */
  railOpen: boolean;
  toolbarAi?: ContentAiToolbar;
  writing: {
    editorKey: string;
    editorRef: Ref<RichTextEditorHandle>;
    initialDoc: TipDoc;
    onDocChange: (doc: TipDoc) => void;
    onEditor: (editor: Editor | null) => void;
    aiActions?: EditorAiActions;
  };
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
  preview,
  railOpen,
  toolbarAi,
  writing,
  banners,
  review,
  rail,
  secondary,
  knowledge,
}: EditorWorkspaceProps) {
  return (
    <div className="grid gap-3" data-testid="editor-workspace">
      {banners}
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
          {review}
        </div>
        <IntelligenceRail {...rail} />
      </div>
      {secondary}
      {knowledge}
    </div>
  );
}
