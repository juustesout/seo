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
 * delegated to handlers the view already owned.
 */
import { useEffect, useState, type ReactNode, type Ref } from 'react';
import type { Editor } from '@tiptap/react';
import type { TipDoc } from '@seo/contracts';
import { RichTextEditor, type RichTextEditorHandle } from '../RichTextEditor';
import type { EditorAiActions } from '../EditorAiBubbleMenu';
import type { ContentAiToolbar } from '../ContentToolbar';
import { EditorSelectionProvider } from '../editor/EditorSelectionContext';
import { EditorContextProvider } from '../editor/EditorContext';
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
  /** Identity and document state exposed through the shared editor context. */
  context: {
    projectId: string;
    contentId: string | null;
    dirty: boolean;
    ready: boolean;
  };
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

export function EditorWorkspace({
  doc,
  editor,
  context,
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
  const [preview, setPreview] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);

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
    <EditorContextProvider
      projectId={context.projectId}
      contentId={context.contentId}
      ready={context.ready}
      dirty={context.dirty}
      doc={doc}
      editor={editor}
    >
      <EditorSelectionProvider>
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
                  toolbar={<ContextualToolbar editor={editor} ai={toolbarAi} />}
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
                />
              </InlineAssistantSlot>
              {review}
            </div>
            <IntelligenceRail {...rail} />
          </div>
          {secondary}
          {knowledge}
        </div>
      </EditorSelectionProvider>
    </EditorContextProvider>
  );
}
