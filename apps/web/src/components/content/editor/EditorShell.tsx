import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { EditorSidebar } from './EditorSidebar';
import { EditorMain } from './EditorMain';
import { toolbarActionsFromEditor, type EditorToolbarActions } from './EditorToolbar';
import { getEditorElement } from './elementRegistry';
import { insertComposition, selectInsertedComposition } from './insertComposition';
import { readCanvasSelection } from './selection';
import type { AutosaveStatus } from '../useAutosave';
import type { EditorElementDefinition, EditorSelection, EditorShellState, SidebarMode } from './types';

export function EditorShell({
  editor,
  toolbarActions,
  saveState,
  children,
  onSelectionChange,
}: {
  editor?: Editor | null;
  toolbarActions?: EditorToolbarActions | null;
  saveState?: AutosaveStatus;
  children: ReactNode;
  onSelectionChange?: (selection: EditorSelection) => void;
}) {
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('elements');
  const [selectedElement, setSelectedElement] = useState<EditorSelection>(null);
  const [insertHint, setInsertHint] = useState<string | null>(null);

  const applySelection = useCallback(
    (selection: EditorSelection, switchToSettings: boolean) => {
      setSelectedElement(selection);
      onSelectionChange?.(selection);
      if (switchToSettings && selection) setSidebarMode('settings');
    },
    [onSelectionChange],
  );

  const handleBrowserSelect = useCallback(
    (element: EditorElementDefinition) => {
      if (!editor || editor.isDestroyed) {
        applySelection({ type: element.type }, true);
        return;
      }
      if (insertComposition(editor, element.type)) {
        selectInsertedComposition(editor, element.type);
        setInsertHint(null);
        applySelection(readCanvasSelection(editor) ?? { type: element.type }, true);
        return;
      }
      const label = getEditorElement(element.type)?.label ?? element.type;
      setInsertHint(`Cannot insert ${label} here`);
    },
    [applySelection, editor],
  );

  const handleCanvasSelect = useCallback(
    (selection: EditorSelection) => {
      if (!selection) {
        applySelection(null, false);
        return;
      }
      const known = getEditorElement(selection.type);
      applySelection(known ? { ...selection, type: known.type } : selection, true);
    },
    [applySelection],
  );

  useEffect(() => {
    if (!editor) return;
    const sync = () => {
      const next = readCanvasSelection(editor);
      if (!next) {
        applySelection(null, false);
        return;
      }
      const known = getEditorElement(next.type);
      applySelection(known ? { ...next, type: known.type } : next, false);
    };
    editor.on('selectionUpdate', sync);
    editor.on('focus', sync);
    return () => {
      editor.off('selectionUpdate', sync);
      editor.off('focus', sync);
    };
  }, [editor, applySelection]);

  const boundToolbar = useMemo(
    () => toolbarActions ?? toolbarActionsFromEditor(editor ?? null),
    [toolbarActions, editor],
  );

  const state: EditorShellState = { sidebarMode, selectedElement };

  return (
    <div
      className="flex min-h-[520px] flex-col overflow-hidden rounded-[10px] border bg-card lg:flex-row"
      data-testid="editor-shell"
      data-sidebar-mode={state.sidebarMode}
      data-selected-type={state.selectedElement?.type ?? ''}
      data-selected-path={(state.selectedElement?.path ?? []).join('.')}
    >
      <EditorSidebar
        mode={sidebarMode}
        onModeChange={setSidebarMode}
        selectedElement={selectedElement}
        onSelectElement={handleBrowserSelect}
        insertHint={insertHint}
      />
      <EditorMain editor={editor} toolbarActions={boundToolbar} saveState={saveState} onSelect={handleCanvasSelect}>
        {children}
      </EditorMain>
    </div>
  );
}
