import type { ReactNode } from 'react';

export type SidebarMode = 'elements' | 'settings';

/**
 * Editor-level selection. `path` is a document index path so nested
 * composition nodes can be addressed later without per-element local state.
 */
export type EditorSelection = {
  type: string;
  id?: string;
  path?: number[];
} | null;

export type EditorShellState = {
  sidebarMode: SidebarMode;
  selectedElement: EditorSelection;
};

export type EditorElementDefinition = {
  type: string;
  label: string;
  category: string;
  icon?: ReactNode;
};

export type EditorSettingsProps = {
  selection: Exclude<EditorSelection, null>;
};

export type EditorSettingsDefinition = {
  type: string;
  render: (props: EditorSettingsProps) => ReactNode;
};
