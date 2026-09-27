/**
 * Tiptap editor wrapper for structured article editing.
 *
 * The editor edits a JSON document (`TipDoc`) and reports every update up as
 * JSON - there is no raw-HTML editing path in the app. Media is handled by the
 * custom ImageBlock node (stable mediaId references). The parent keys the
 * component by `editingId`/load sequence so opening another article fully
 * re-initializes the editor instead of reusing stale state; the imperative
 * handle exists so sibling panels (the outline) can drive selection.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { designSystemCssVariables, effectiveDesignSystem, type DesignSystem, type TipDoc } from '@seo/contracts';
import { EditorAiBubbleMenu, type EditorAiActions } from './EditorAiBubbleMenu';
import { createEditorExtensions } from './editor/extensions';
import { sanitizeEditorDoc } from './editor/sanitizeDoc';
import { canvasModeForDocument } from './editor/compositionPresentation';
import { useDesignSystem } from '../../lib/designSystem';
import './editor/compositionEditor.css';

export interface RichTextEditorHandle {
  /** Scroll the editor to and select the n-th heading in the document. */
  selectHeading: (index: number) => void;
}

interface RichTextEditorProps {
  initialDoc: TipDoc;
  onDocChange?: (doc: TipDoc) => void;
  onEditor?: (editor: Editor | null) => void;
  /** When present, a selection bubble menu offers the AI edit operations. */
  aiActions?: EditorAiActions;
  /**
   * Effective design system for the page canvas. Defaults to the surrounding
   * `DesignSystemProvider`, then to the safe built-in token set, so the editor
   * uses the same tokens as the CanonicalRenderer.
   */
  designSystem?: DesignSystem;
}

/**
 * Creates the Tiptap editor for one article. Props: `initialDoc` seeds the
 * content, `onDocChange` lifts every JSON update to the parent workspace, and
 * `onEditor` hands the live instance up once created so the toolbar/outline can
 * act on it. The imperative handle exposes `selectHeading` for outline clicks.
 */
export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(function RichTextEditor(
  { initialDoc, onDocChange, onEditor, aiActions, designSystem },
  ref,
) {
  const sanitizedDoc = useMemo(() => sanitizeEditorDoc(initialDoc), [initialDoc]);
  const [canvasMode, setCanvasMode] = useState<'page' | 'article'>(() => canvasModeForDocument(sanitizedDoc));
  const contextDesignSystem = useDesignSystem();
  const resolvedDesignSystem = effectiveDesignSystem(designSystem ?? contextDesignSystem);

  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: sanitizedDoc,
    onUpdate: ({ editor: e }) => {
      const next = e.getJSON() as unknown as TipDoc;
      const mode = canvasModeForDocument(next);
      setCanvasMode((current) => (mode === current ? current : mode));
      onDocChange?.(next);
    },
  });

  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;
  useEffect(() => {
    onEditorRef.current?.(editor);
  }, [editor]);

  useImperativeHandle(
    ref,
    () => ({
      selectHeading(index: number) {
        if (!editor) return;
        let found = -1;
        let seen = 0;
        editor.state.doc.descendants((node, pos) => {
          if (found !== -1) return false;
          if (node.type.name === 'heading') {
            // Mirror `docHeadings` (the outline's source) exactly: it lists only
            // headings with text, so an empty heading must not consume an outline
            // index here either - otherwise the outline jumps to the wrong node.
            if (node.textContent.trim()) {
              if (seen === index) found = pos;
              seen += 1;
            }
          }
          return true;
        });
        if (found === -1) return;
        // `found` is the position before the heading node; +1 places the caret
        // inside the heading's inline content (selecting the boundary itself is
        // not a valid text position).
        editor.chain().focus().setTextSelection(found + 1).scrollIntoView().run();
      },
    }),
    [editor],
  );

  const pageMode = canvasMode === 'page';

  return (
    <div className="rt-editor" data-canvas-mode={canvasMode}>
      <div
        className={pageMode ? 'cosmos-doc rt-page-canvas' : undefined}
        style={pageMode ? (designSystemCssVariables(resolvedDesignSystem) as CSSProperties) : undefined}
        data-editor-canvas={pageMode ? 'composition' : undefined}
      >
        <div className={pageMode ? 'cosmos-container' : undefined}>
          <EditorContent editor={editor} />
        </div>
      </div>
      {aiActions && <EditorAiBubbleMenu editor={editor} actions={aiActions} />}
    </div>
  );
});
