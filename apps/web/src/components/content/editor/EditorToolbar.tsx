import { useEffect, useReducer } from 'react';
import type { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AutosaveStatus } from '../useAutosave';
import { SAVE_LABEL } from '../ContentEditorHeader';

export type EditorToolbarActions = {
  undo: () => void;
  redo: () => void;
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
  };
}

export function EditorToolbar({
  editor,
  actions,
  canUndo,
  canRedo,
  saveState,
}: {
  editor?: Editor | null;
  actions?: EditorToolbarActions | null;
  canUndo?: boolean;
  canRedo?: boolean;
  saveState?: AutosaveStatus;
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
      {saveState && (
        <span
          className={cn(
            'ml-auto text-xs text-muted-foreground',
            saveState === 'failed' && 'text-destructive',
            saveState === 'saved' && 'text-success',
          )}
          data-testid="editor-toolbar-save"
        >
          {SAVE_LABEL[saveState]}
        </span>
      )}
    </div>
  );
}
