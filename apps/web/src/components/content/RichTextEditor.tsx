import { forwardRef, useImperativeHandle } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import type { TipDoc } from '@seo/contracts';

export interface RichTextEditorHandle {
  /** Scroll the editor to and select the n-th heading in the document. */
  selectHeading: (index: number) => void;
}

interface RichTextEditorProps {
  initialDoc: TipDoc;
  onDocChange?: (doc: TipDoc) => void;
  onEditor?: (editor: Editor | null) => void;
}

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(function RichTextEditor(
  { initialDoc, onDocChange, onEditor },
  ref,
) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
    ],
    content: initialDoc,
    onUpdate: ({ editor: e }) => {
      onDocChange?.(e.getJSON() as unknown as TipDoc);
    },
  });

  onEditor?.(editor);

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

  return (
    <div className="rt-editor">
      <EditorContent editor={editor} />
    </div>
  );
});
