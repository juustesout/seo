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
import { DEFAULT_DESIGN_SYSTEM, designSystemCssVariables, type TipDoc } from '@seo/contracts';
import { EditorAiBubbleMenu, type EditorAiActions } from './EditorAiBubbleMenu';
import { createEditorExtensions } from './editor/extensions';
import { sanitizeEditorDoc } from './editor/sanitizeDoc';
import { canvasModeForDocument } from './editor/compositionPresentation';
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
}

/**
 * Creates the Tiptap editor for one article. Props: `initialDoc` seeds the
 * content, `onDocChange` lifts every JSON update to the parent workspace, and
 * `onEditor` hands the live instance up once created so the toolbar/outline can
 * act on it. The imperative handle exposes `selectHeading` for outline clicks.
 */
export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(function RichTextEditor(
  { initialDoc, onDocChange, onEditor, aiActions },
  ref,
) {
  const sanitizedDoc = useMemo(() => sanitizeEditorDoc(initialDoc), [initialDoc]);
  const [canvasMode, setCanvasMode] = useState<'page' | 'article'>(() => canvasModeForDocument(sanitizedDoc));

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
            if (seen === index) found = pos;
            seen += 1;
          }
          return true;
        });
        if (found === -1) return;
        editor.chain().focus().setTextSelection(found).scrollIntoView().run();
      },
    }),
    [editor],
  );

  const pageMode = canvasMode === 'page';

  return (
    <div className="rt-editor" data-canvas-mode={canvasMode}>
      <div
        className={pageMode ? 'cosmos-doc rt-page-canvas' : undefined}
        style={pageMode ? (designSystemCssVariables(DEFAULT_DESIGN_SYSTEM) as CSSProperties) : undefined}
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
