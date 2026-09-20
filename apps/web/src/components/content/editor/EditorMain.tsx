import type { ReactNode } from 'react';
import { EditorToolbar } from './EditorToolbar';
import { EditorCanvas } from './EditorCanvas';
import type { Editor } from '@tiptap/react';
import type { EditorSelection } from './types';

export function EditorMain({
  editor,
  toolbar,
  onSelect,
  children,
}: {
  editor?: Editor | null;
  /** Custom toolbar; defaults to the composition toolbar. */
  toolbar?: ReactNode;
  onSelect?: (selection: EditorSelection) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="editor-main">
      {toolbar ?? <EditorToolbar editor={editor} />}
      <EditorCanvas editor={editor} onSelect={onSelect}>
        {children}
      </EditorCanvas>
    </div>
  );
}
