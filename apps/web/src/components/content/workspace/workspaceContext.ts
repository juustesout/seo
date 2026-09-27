/**
 * Contextual workspace model (R5.8).
 *
 * One pure derivation of "what is relevant right now" from the canonical
 * workspace state: the active surface (editor canvas, preview, Composer or
 * Designer), the canonical editor selection and the preview viewport. It owns
 * no state - every value comes from an existing owner (the route's mode,
 * `EditorSelectionContext`, the shell's document-scoped viewport), so contextual
 * UI is derived from canonical state, never a second source of truth.
 *
 * The surface mapping and the surface controls are the single place that turns
 * "where are we" into "which controls may show", so the chrome does not scatter
 * `if (mode === ...)` / `if (preview === ...)` conditions through components.
 */
import type { WorkspaceMode } from '../../../workspace/WorkspaceModeSwitcher';
import { EMPTY_EDITOR_SELECTION, type EditorSelectionSnapshot } from '../editor/editorContext';
import { resolveElementType } from '../editor/elementRegistry';
import { DEFAULT_PREVIEW_VIEWPORT, type PreviewViewport } from './previewViewport';

/** The surface the workspace is actually showing right now. */
export type WorkspaceSurface = 'canvas' | 'preview' | 'composer' | 'designer';

/** The intelligence rail's segmented areas. */
export type ContextRailTab = 'outline' | 'seo' | 'media' | 'insights';

/**
 * The canonical workspace context. `selection` is the live, document-scoped
 * snapshot owned by `EditorSelectionContext`; `viewport` is the shell's
 * document-scoped inspection state. Neither is copied or stored here.
 */
export interface WorkspaceContext {
  surface: WorkspaceSurface;
  selection: EditorSelectionSnapshot;
  viewport: PreviewViewport;
}

/** The context before any editor selection/viewport exists. */
export const DEFAULT_WORKSPACE_CONTEXT: WorkspaceContext = {
  surface: 'canvas',
  selection: EMPTY_EDITOR_SELECTION,
  viewport: DEFAULT_PREVIEW_VIEWPORT,
};

/**
 * Map the route mode plus the preview toggle onto the surface that is actually
 * visible. Composer and Designer are their own surfaces; the editor mode is
 * either the editable canvas or the read-only preview.
 */
export function workspaceSurface(mode: WorkspaceMode, preview: boolean): WorkspaceSurface {
  if (mode === 'composer') return 'composer';
  if (mode === 'designer') return 'designer';
  return preview ? 'preview' : 'canvas';
}

/**
 * Only the editor canvas may mutate the document. Preview is inspection-only and
 * Composer/Designer never mount the editor, so none of them expose editing.
 */
export function isEditingSurface(surface: WorkspaceSurface): boolean {
  return surface === 'canvas';
}

export interface SurfaceControls {
  /** The editor canvas is mounted (canvas or preview): canvas controls may render. */
  editor: boolean;
  /** Insert rail toggle: a document mutation, canvas only. */
  insert: boolean;
  /** Tools rail toggle: document inspection, available on any editor surface. */
  tools: boolean;
  /** Editor/preview toggle: only meaningful while the editor canvas is mounted. */
  preview: boolean;
}

/** The single mapping from surface to the editor-canvas controls it may show. */
export function surfaceControls(surface: WorkspaceSurface): SurfaceControls {
  switch (surface) {
    case 'canvas':
      return { editor: true, insert: true, tools: true, preview: true };
    case 'preview':
      return { editor: true, insert: false, tools: true, preview: true };
    default:
      return { editor: false, insert: false, tools: false, preview: false };
  }
}

/** The canonical element type of the current selection, resolved, or null. */
export function contextualSelectionType(selection: EditorSelectionSnapshot): string | null {
  return selection.nodeType ? resolveElementType(selection.nodeType) : null;
}

/**
 * The rail areas meaningful for the current context, in presentation order.
 * Media is offered only where the document can actually be mutated (the
 * canvas): preview must never expose an editing surface.
 */
export function railTabsForContext(
  context: WorkspaceContext,
  available: { media: boolean; insights: boolean },
): ContextRailTab[] {
  const tabs: ContextRailTab[] = ['outline', 'seo'];
  if (available.media && isEditingSurface(context.surface)) tabs.push('media');
  if (available.insights) tabs.push('insights');
  return tabs;
}

/**
 * The tab the rail shows until the user chooses one for this document. An image
 * selection points at the media library (canvas only); otherwise the rail stays
 * at the document-level Outline so it is never empty. An explicit user choice is
 * UI state and always wins over this default.
 */
export function defaultRailTabForContext(context: WorkspaceContext, tabs: ContextRailTab[]): ContextRailTab {
  if (contextualSelectionType(context.selection) === 'image' && tabs.includes('media')) return 'media';
  return tabs.includes('outline') ? 'outline' : (tabs[0] ?? 'outline');
}
