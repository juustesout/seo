import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { EditorSidebar } from './EditorSidebar';
import { EditorMain } from './EditorMain';
import { getEditorElement } from './elementRegistry';
import { insertComposition, selectInsertedComposition } from './insertComposition';
import { readCanvasSelection } from './selection';
import { useEditorSelection } from './EditorSelectionContext';
import { useDocumentScopedState } from '../workspace/workspaceState';
import type { EditorElementDefinition, EditorSelection, SidebarMode } from './types';

export function EditorShell({
  editor,
  toolbar,
  children,
  showRail = true,
  onSelectionChange,
}: {
  editor?: Editor | null;
  /** When provided, replaces the default composition toolbar above the canvas. */
  toolbar?: ReactNode;
  children: ReactNode;
  /** Collapsible insert rail; on-demand in the workspace, open by default standalone. */
  showRail?: boolean;
  onSelectionChange?: (selection: EditorSelection) => void;
}) {
  const shared = useEditorSelection();
  // Document-scoped: which side panel is active resets with the document (R5.2.7).
  const [sidebarMode, setSidebarMode] = useDocumentScopedState<SidebarMode>('elements');
  const [localSelection, setLocalSelection] = useState<EditorSelection>(null);
  const [insertHint, setInsertHint] = useState<string | null>(null);

  // Prefer the canonical selection projection; fall back to local state when
  // the surface is used standalone (tests, other hosts).
  const selectedElement = shared ? shared.element : localSelection;

  const applySelection = useCallback(
    (selection: EditorSelection, switchToSettings: boolean) => {
      if (!shared) setLocalSelection(selection);
      onSelectionChange?.(selection);
      if (switchToSettings && selection) setSidebarMode('settings');
    },
    [shared, onSelectionChange],
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
    // The canonical owner publishes selection when a provider is present.
    if (shared || !editor) return;
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
  }, [editor, applySelection, shared]);

  // Reveal requests (e.g. an Agent insertion that just selected its result)
  // open the settings view for the already-lifted selection.
  const revealRequest = shared?.revealRequest ?? 0;
  useEffect(() => {
    if (revealRequest > 0) setSidebarMode('settings');
  }, [revealRequest]);

  return (
    <div
      className="flex min-h-[520px] flex-col overflow-hidden rounded-[10px] border bg-card lg:flex-row"
      data-testid="editor-shell"
      data-sidebar-mode={sidebarMode}
      data-rail-open={showRail ? 'true' : 'false'}
      data-selected-type={selectedElement?.type ?? ''}
      data-selected-path={(selectedElement?.path ?? []).join('.')}
    >
      {showRail && (
        <EditorSidebar
          mode={sidebarMode}
          onModeChange={setSidebarMode}
          selectedElement={selectedElement}
          onSelectElement={handleBrowserSelect}
          insertHint={insertHint}
        />
      )}
      <EditorMain editor={editor} toolbar={toolbar} onSelect={handleCanvasSelect}>
        {children}
      </EditorMain>
    </div>
  );
}
