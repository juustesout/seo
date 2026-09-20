import { useEffect, useReducer } from 'react';
import type { Editor } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import { Button } from '@/components/ui/button';
import { COMPOSITION_NODE_TYPES } from './CompositionNodes';
import { deleteSelectedComposition } from './insertComposition';

export type EditorToolbarActions = {
  undo: () => void;
  redo: () => void;
  deleteSelected?: () => void;
};

export function toolbarActionsFromEditor(editor: Editor | null): EditorToolbarActions | null {
  if (!editor) return null;
  return {
    undo: () => {
      editor.chain().focus().undo().run();
    },
    redo: () => {
      editor.chain().focus().redo().run();
    },
    deleteSelected: () => {
      deleteSelectedComposition(editor);
    },
  };
}

/** True when the current selection is a composition node that can be deleted. */
export function canDeleteComposition(editor: Editor | null | undefined): boolean {
  if (!editor || editor.isDestroyed) return false;
  const { selection } = editor.state;
  if (!(selection instanceof NodeSelection)) return false;
  return (COMPOSITION_NODE_TYPES as readonly string[]).includes(selection.node.type.name);
}

/**
 * Composition toolbar: undo/redo plus deleting the selected composition node.
 * Save status is deliberately not shown here - the document header owns the one
 * save indicator, so this surface never duplicates it.
 */
export function EditorToolbar({
  editor,
  actions,
  canUndo,
  canRedo,
}: {
  editor?: Editor | null;
  actions?: EditorToolbarActions | null;
  canUndo?: boolean;
  canRedo?: boolean;
}) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!editor) return;
    const onTransaction = () => refresh();
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
    };
  }, [editor]);

  const bound = actions ?? toolbarActionsFromEditor(editor ?? null);
  const undoEnabled = canUndo ?? editor?.can().undo() ?? false;
  const redoEnabled = canRedo ?? editor?.can().redo() ?? false;
  const deleteEnabled = canDeleteComposition(editor ?? null);

  return (
    <div
      className="flex flex-wrap items-center gap-1 border-b bg-muted/40 px-2 py-1.5"
      data-testid="editor-toolbar"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        title="Undo"
        disabled={!bound || !undoEnabled}
        onClick={() => bound?.undo()}
      >
        Undo
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        title="Redo"
        disabled={!bound || !redoEnabled}
        onClick={() => bound?.redo()}
      >
        Redo
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        title="Delete"
        disabled={!bound?.deleteSelected || !deleteEnabled}
        onClick={() => bound?.deleteSelected?.()}
      >
        Delete
      </Button>
    </div>
  );
}
