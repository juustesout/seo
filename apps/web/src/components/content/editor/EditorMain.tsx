import type { ReactNode } from 'react';
import { EditorToolbar, type EditorToolbarActions } from './EditorToolbar';
import { EditorCanvas } from './EditorCanvas';
import type { Editor } from '@tiptap/react';
import type { AutosaveStatus } from '../useAutosave';
import type { EditorSelection } from './types';

export function EditorMain({
  editor,
  toolbarActions,
  saveState,
  onSelect,
  children,
}: {
  editor?: Editor | null;
  toolbarActions?: EditorToolbarActions | null;
  saveState?: AutosaveStatus;
  onSelect?: (selection: EditorSelection) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="editor-main">
      <EditorToolbar editor={editor} actions={toolbarActions} saveState={saveState} />
      <EditorCanvas editor={editor} onSelect={onSelect}>
        {children}
      </EditorCanvas>
    </div>
  );
}
