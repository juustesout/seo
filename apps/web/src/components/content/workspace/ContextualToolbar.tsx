/**
 * Contextual toolbar for the editor workspace.
 *
 * One merged bar: the formatting markdown controls plus the composition
 * selection action. It reads the live Tiptap selection so the delete action
 * only appears when a composition node is selected, and it never renders save
 * status (the document header owns that).
 */
import { useEffect, useReducer } from 'react';
import type { Editor } from '@tiptap/react';
import { ContentToolbar, type ContentAiToolbar } from '../ContentToolbar';
import { canDeleteComposition, toolbarActionsFromEditor } from '../editor/EditorToolbar';
import { Button } from '@/components/ui/button';

export function ContextualToolbar({ editor, ai }: { editor: Editor | null; ai?: ContentAiToolbar }) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!editor) return;
    const onTransaction = () => refresh();
    editor.on('transaction', onTransaction);
    editor.on('selectionUpdate', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
      editor.off('selectionUpdate', onTransaction);
    };
  }, [editor]);

  const actions = toolbarActionsFromEditor(editor);
  const canDelete = canDeleteComposition(editor);

  return (
    <ContentToolbar
      editor={editor}
      ai={ai}
      extra={
        canDelete && actions?.deleteSelected ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            title="Delete the selected element"
            onClick={() => actions.deleteSelected?.()}
          >
            Delete element
          </Button>
        ) : null
      }
    />
  );
}
