import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { readCanvasSelection } from './selection';
import type { EditorSelection } from './types';

export function EditorCanvas({
  editor,
  onSelect,
  children,
}: {
  editor?: Editor | null;
  onSelect?: (selection: EditorSelection) => void;
  children: ReactNode;
}) {
  const handlePointerUp = () => {
    if (!editor || editor.isDestroyed) return;
    onSelect?.(readCanvasSelection(editor));
  };

  return (
    <div className="min-w-0 flex-1" data-testid="editor-canvas" onPointerUp={handlePointerUp}>
      {children}
    </div>
  );
}
