/**
 * R5.8 contextual workspace model. Pure derivation tests: the surface mapping,
 * the editor-canvas controls, the selection projection and the rail areas are
 * all derived from canonical inputs, with no state of their own.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITOR_SELECTION, type EditorSelectionSnapshot } from '../editor/editorContext';
import {
  DEFAULT_WORKSPACE_CONTEXT,
  contextualSelectionType,
  defaultRailTabForContext,
  isEditingSurface,
  railTabsForContext,
  surfaceControls,
  workspaceSurface,
  type ContextRailTab,
  type WorkspaceContext,
  type WorkspaceSurface,
} from './workspaceContext';

function context(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return { ...DEFAULT_WORKSPACE_CONTEXT, ...overrides };
}

describe('workspace context model', () => {
  it('maps the workspace mode plus the preview toggle to the visible surface', () => {
    expect(workspaceSurface('editor', false)).toBe('canvas');
    expect(workspaceSurface('editor', true)).toBe('preview');
    expect(workspaceSurface('composer', false)).toBe('composer');
    expect(workspaceSurface('designer', true)).toBe('designer');
  });

  it('treats only the editor canvas as an editing surface', () => {
    const editing: WorkspaceSurface = 'canvas';
    expect(isEditingSurface(editing)).toBe(true);
    for (const surface of ['preview', 'composer', 'designer'] as WorkspaceSurface[]) {
      expect(isEditingSurface(surface)).toBe(false);
    }
  });

  it('derives the editor-canvas controls from the surface in one place', () => {
    expect(surfaceControls('canvas')).toEqual({ editor: true, insert: true, tools: true, preview: true });
    expect(surfaceControls('preview')).toEqual({ editor: true, insert: false, tools: true, preview: true });
    expect(surfaceControls('composer')).toEqual({ editor: false, insert: false, tools: false, preview: false });
    expect(surfaceControls('designer')).toEqual({ editor: false, insert: false, tools: false, preview: false });
  });

  it('projects the resolved element type from the canonical selection without inventing one', () => {
    const cursorInParagraph: EditorSelectionSnapshot = { type: 'cursor', nodeType: 'paragraph' };
    const imageNode: EditorSelectionSnapshot = { type: 'node', nodeType: 'image' };
    const sectionNode: EditorSelectionSnapshot = { type: 'node', nodeType: 'section' };
    expect(contextualSelectionType(EMPTY_EDITOR_SELECTION)).toBeNull();
    expect(contextualSelectionType(cursorInParagraph)).toBe('paragraph');
    expect(contextualSelectionType(imageNode)).toBe('image');
    // Aliases resolve through the element registry to the registered type.
    expect(contextualSelectionType(sectionNode)).toBe('compositionSection');
  });

  it('offers the Media area only on the editable canvas surface', () => {
    const available = { media: true, insights: true };
    expect(railTabsForContext(context({ surface: 'canvas' }), available)).toEqual(['outline', 'seo', 'media', 'insights']);
    expect(railTabsForContext(context({ surface: 'preview' }), available)).toEqual(['outline', 'seo', 'insights']);
    expect(railTabsForContext(context({ surface: 'composer' }), available)).toEqual(['outline', 'seo', 'insights']);
    expect(railTabsForContext(context({ surface: 'designer' }), available)).toEqual(['outline', 'seo', 'insights']);
  });

  it('omits optional areas that the context does not provide', () => {
    expect(railTabsForContext(context(), { media: false, insights: false })).toEqual(['outline', 'seo']);
  });

  it('defaults to Outline, or the media library for an image on the canvas', () => {
    const tabs: ContextRailTab[] = ['outline', 'seo', 'media', 'insights'];
    const image: EditorSelectionSnapshot = { type: 'node', nodeType: 'image' };
    expect(defaultRailTabForContext(context(), tabs)).toBe('outline');
    expect(defaultRailTabForContext(context({ selection: image }), tabs)).toBe('media');
    // No Media area in this context (preview): the image cannot pull the rail to it.
    expect(
      defaultRailTabForContext(context({ surface: 'preview', selection: image }), ['outline', 'seo', 'insights']),
    ).toBe('outline');
  });
});
