/**
 * Editor-native image insertion helper tests (R3.1).
 *
 * Pin the deterministic pieces of the editor side: which selection becomes which
 * insertion target, which bounded context is built (and when the builder refuses
 * to guess), and that applying an operation is one undoable editor transaction
 * that refuses an unresolvable target or a non-library candidate.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import type { InsertImageOperation, TipDoc } from '@seo/contracts';
import { createEditorExtensions } from './extensions';
import { buildEditorContextSnapshot, type EditorContextSnapshot, type EditorSelectionSnapshot } from './editorContext';
import { readSelectionSnapshot } from './selection';
import {
  applyImageInsertionOperation,
  imageInsertionContextFromSnapshot,
  imageInsertionTargetFromSelection,
  readEditorBackgroundTarget,
  readEditorHeroTarget,
  readEditorImageSemantics,
  readEditorSectionTarget,
  resolveImageInsertionRange,
} from './imageInsertion';

const editors: Editor[] = [];

function makeEditor(): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions({ nodeViews: false }),
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Solar energy' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Solar panels store energy.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Battery storage holds charge.' }] },
      ],
    },
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

const CURSOR_IN_SECOND = 43;

function snapshotOf(editor: Editor, over: Partial<EditorContextSnapshot> = {}, dirty = false): EditorContextSnapshot {
  const base = buildEditorContextSnapshot({
    projectId: 'p1',
    contentId: 'c1',
    ready: true,
    doc: editor.getJSON() as TipDoc,
    dirty,
    selection: readSelectionSnapshot(editor),
  });
  return { ...base, ...over };
}

describe('imageInsertionTargetFromSelection', () => {
  it('maps cursor, text and block selections', () => {
    expect(imageInsertionTargetFromSelection({ type: 'cursor', from: 5 })).toEqual({ kind: 'cursor', position: 5 });
    expect(imageInsertionTargetFromSelection({ type: 'text', from: 1, to: 4 })).toEqual({
      kind: 'text-selection',
      from: 1,
      to: 4,
    });
    expect(imageInsertionTargetFromSelection({ type: 'node', nodeType: 'paragraph', nodePath: [1] })).toEqual({
      kind: 'block',
      path: [1],
    });
  });

  it('has no target for an empty selection or a selected image (replacement is out of scope)', () => {
    expect(imageInsertionTargetFromSelection({ type: 'none' })).toBeNull();
    expect(imageInsertionTargetFromSelection({ type: 'node', nodeType: 'image', nodePath: [1] })).toBeNull();
  });
});

describe('readEditorImageSemantics', () => {
  it('reads surrounding blocks and the nearest preceding heading', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(CURSOR_IN_SECOND);
    const semantics = readEditorImageSemantics(editor);
    expect(semantics.nearbyText).toContain('Solar panels store energy.');
    expect(semantics.nearbyText).toContain('Battery storage holds charge.');
    expect(semantics.sectionHeading).toBe('Solar energy');
    expect(semantics.selectedText).toBeUndefined();
    expect(semantics.targetNodeType).toBe('paragraph');
  });

  it('reports the node type of the block the selection sits on (R4.1 role hint)', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(2);
    expect(readEditorImageSemantics(editor).targetNodeType).toBe('heading');
  });

  it('captures the selected text', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection({ from: 15, to: 20 });
    expect(readEditorImageSemantics(editor).selectedText).toBe('Solar');
  });

  it('is inert without an editor', () => {
    expect(readEditorImageSemantics(null)).toEqual({ nearbyText: '' });
  });
});

describe('imageInsertionContextFromSnapshot', () => {
  it('builds a bounded context for a clean persisted document', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(CURSOR_IN_SECOND);
    const snapshot = snapshotOf(editor);
    const context = imageInsertionContextFromSnapshot(snapshot, readEditorImageSemantics(editor));
    expect(context).not.toBeNull();
    expect(context?.revision).toBe(snapshot.document.revision);
    expect(context?.target).toEqual({ kind: 'cursor', position: CURSOR_IN_SECOND });
    expect(context?.sectionHeading).toBe('Solar energy');
    expect(context?.targetNodeType).toBe('paragraph');
    expect(context?.nearbyText.length).toBeLessThanOrEqual(600);
  });

  it('refuses to guess when the document is dirty, unsaved or has no target', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(CURSOR_IN_SECOND);
    const semantics = readEditorImageSemantics(editor);

    expect(imageInsertionContextFromSnapshot(snapshotOf(editor, {}, true), semantics)).toBeNull();
    expect(imageInsertionContextFromSnapshot({ ...snapshotOf(editor), contentId: null }, semantics)).toBeNull();
    expect(
      imageInsertionContextFromSnapshot(
        { ...snapshotOf(editor), document: { ...snapshotOf(editor).document, unrepresentable: true } },
        semantics,
      ),
    ).toBeNull();

    editor.commands.blur();
    const noSelection: EditorContextSnapshot = { ...snapshotOf(editor), selection: { type: 'none' } };
    expect(imageInsertionContextFromSnapshot(noSelection, semantics)).toBeNull();
  });
});

describe('applyImageInsertionOperation', () => {
  function operation(over: Partial<InsertImageOperation> = {}): InsertImageOperation {
    return {
      type: 'insert_image',
      target: { kind: 'cursor', position: CURSOR_IN_SECOND },
      image: { assetId: 'm1', url: 'https://cdn.test/solar.png', alt: 'Solar panels' },
      ...over,
    };
  }

  function hasImage(editor: Editor): boolean {
    return JSON.stringify(editor.getJSON()).includes('"type":"image"');
  }

  it('inserts one library image at the target and undo removes it', () => {
    const editor = makeEditor();
    const result = applyImageInsertionOperation(editor, operation());
    expect(result).toEqual({ ok: true });
    expect(hasImage(editor)).toBe(true);

    editor.commands.undo();
    expect(hasImage(editor)).toBe(false);
  });

  it('selects the inserted image so its settings can be revealed, without an extra undo step', () => {
    const editor = makeEditor();
    const result = applyImageInsertionOperation(editor, operation());
    expect(result).toEqual({ ok: true });

    const { selection } = editor.state;
    expect(selection).toBeInstanceOf(NodeSelection);
    expect(selection instanceof NodeSelection ? selection.node.type.name : null).toBe('image');
    expect(selection instanceof NodeSelection ? selection.node.attrs.mediaId : null).toBe('m1');

    // The selection change is not a separate history entry: one undo removes the image.
    editor.commands.undo();
    expect(hasImage(editor)).toBe(false);
  });

  it('refuses a candidate without a library reference', () => {
    const editor = makeEditor();
    const result = applyImageInsertionOperation(editor, operation({ image: { url: 'https://cdn.test/x.png', alt: 'x' } }));
    expect(result).toEqual({ ok: false, reason: 'missing-asset' });
    expect(hasImage(editor)).toBe(false);
  });

  it('refuses an unresolvable target instead of inserting arbitrarily', () => {
    const editor = makeEditor();
    const result = applyImageInsertionOperation(editor, operation({ target: { kind: 'cursor', position: 999_999 } }));
    expect(result).toEqual({ ok: false, reason: 'unresolved-target' });
    expect(hasImage(editor)).toBe(false);
  });

  it('reports no editor', () => {
    expect(applyImageInsertionOperation(null, operation())).toEqual({ ok: false, reason: 'no-editor' });
  });

  it('resolves a block target to a safe boundary', () => {
    const editor = makeEditor();
    expect(resolveImageInsertionRange(editor, { kind: 'block', path: [1] })).toBe(15);
    expect(resolveImageInsertionRange(editor, { kind: 'block', path: [99] })).toBeNull();
  });
});

describe('section targeting (R4.2)', () => {
  function makeEditorWith(content: JSONContent[]): Editor {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: { type: 'doc', content },
    });
    editors.push(editor);
    return editor;
  }

  it('reads the nearest preceding heading as a section target', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(CURSOR_IN_SECOND);
    expect(readEditorSectionTarget(editor)).toEqual({
      kind: 'section',
      sectionPath: [0],
      anchorPath: [0],
      heading: 'Solar energy',
    });
  });

  it('uses the heading itself when the cursor sits on it', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(2);
    expect(readEditorSectionTarget(editor)).toEqual({
      kind: 'section',
      sectionPath: [0],
      anchorPath: [0],
      heading: 'Solar energy',
    });
  });

  it('returns null when the document has no heading to anchor to', () => {
    const editor = makeEditorWith([{ type: 'paragraph', content: [{ type: 'text', text: 'Just prose.' }] }]);
    editor.commands.setTextSelection(3);
    expect(readEditorSectionTarget(editor)).toBeNull();
  });

  it('addresses an explicit composition section through its heading child', () => {
    const editor = makeEditorWith([
      {
        type: 'compositionSection',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Solar energy' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Panels on roofs.' }] },
        ],
      },
    ]);
    editor.commands.setTextSelection(6);
    expect(readEditorSectionTarget(editor)).toEqual({
      kind: 'section',
      sectionPath: [0],
      anchorPath: [0, 0],
      heading: 'Solar energy',
    });
  });

  it('carries the section hint into the transmitted context', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(CURSOR_IN_SECOND);
    const context = imageInsertionContextFromSnapshot(snapshotOf(editor), readEditorImageSemantics(editor));
    expect(context?.target).toEqual({ kind: 'cursor', position: CURSOR_IN_SECOND });
    expect(context?.sectionTarget).toEqual({
      kind: 'section',
      sectionPath: [0],
      anchorPath: [0],
      heading: 'Solar energy',
    });
  });

  it('resolves a section target to the position after the heading', () => {
    const editor = makeEditor();
    const heading = editor.state.doc.child(0);
    // Anchored inside the heading text (after its content), not on the raw block
    // boundary, so the heading is never replaced by the image.
    expect(resolveImageInsertionRange(editor, { kind: 'section', sectionPath: [0], anchorPath: [0] })).toBe(
      heading.nodeSize - 1,
    );
    expect(resolveImageInsertionRange(editor, { kind: 'section', sectionPath: [1], anchorPath: [1] })).toBeNull();
  });

  it('inserts a section image after the heading and undo removes it', () => {
    const editor = makeEditor();
    const result = applyImageInsertionOperation(editor, {
      type: 'insert_image',
      target: { kind: 'section', sectionPath: [0], anchorPath: [0], heading: 'Solar energy' },
      image: { assetId: 'm1', url: 'https://cdn.test/solar.png', alt: 'Solar panels' },
      visual: { role: 'section', intent: 'reinforce', placement: 'contained' },
    });
    expect(result).toEqual({ ok: true });
    const content = editor.getJSON().content ?? [];
    expect(content[0]!.type).toBe('heading');
    expect(content[1]!.type).toBe('image');

    editor.commands.undo();
    expect(JSON.stringify(editor.getJSON()).includes('"type":"image"')).toBe(false);
  });
});

describe('hero targeting (R4.3)', () => {
  function makeEditorWith(content: JSONContent[]): Editor {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: { type: 'doc', content },
    });
    editors.push(editor);
    return editor;
  }

  it('reads the first top-level heading as the page hero', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(CURSOR_IN_SECOND);
    expect(readEditorHeroTarget(editor)).toEqual({
      kind: 'hero',
      heroPath: [0],
      anchorPath: [0],
      nodeType: 'heading',
      placement: 'full_bleed',
      heading: 'Solar energy',
      supportingText: 'Solar panels store energy. Battery storage holds charge.',
    });
  });

  it('prefers an explicit composition hero the selection sits in', () => {
    const editor = makeEditorWith([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Page title' }] },
      {
        type: 'compositionHero',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Storage' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Batteries hold charge.' }] },
        ],
      },
    ]);
    editor.commands.setTextSelection(15);
    expect(readEditorHeroTarget(editor)).toEqual({
      kind: 'hero',
      heroPath: [1],
      anchorPath: [1, 0],
      nodeType: 'compositionHero',
      placement: 'full_bleed',
      heading: 'Storage',
      supportingText: 'Batteries hold charge.',
    });
  });

  it('returns null when the document has no heading or hero', () => {
    const editor = makeEditorWith([{ type: 'paragraph', content: [{ type: 'text', text: 'Just prose.' }] }]);
    editor.commands.setTextSelection(3);
    expect(readEditorHeroTarget(editor)).toBeNull();
  });

  it('carries the hero hint into the transmitted context', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(CURSOR_IN_SECOND);
    const context = imageInsertionContextFromSnapshot(snapshotOf(editor), readEditorImageSemantics(editor));
    expect(context?.heroTarget).toMatchObject({
      kind: 'hero',
      heroPath: [0],
      anchorPath: [0],
      placement: 'full_bleed',
      heading: 'Solar energy',
    });
  });

  it('resolves a hero target to the position after the hero heading', () => {
    const editor = makeEditor();
    const heading = editor.state.doc.child(0);
    expect(resolveImageInsertionRange(editor, { kind: 'hero', heroPath: [0], anchorPath: [0], nodeType: 'heading', placement: 'full_bleed' })).toBe(
      heading.nodeSize - 1,
    );
    expect(resolveImageInsertionRange(editor, { kind: 'hero', heroPath: [1], anchorPath: [1], nodeType: 'heading', placement: 'full_bleed' })).toBeNull();
  });

  it('inserts a hero image after the heading and undo removes it', () => {
    const editor = makeEditor();
    const result = applyImageInsertionOperation(editor, {
      type: 'insert_image',
      target: { kind: 'hero', heroPath: [0], anchorPath: [0], nodeType: 'heading', placement: 'full_bleed' },
      image: { assetId: 'm1', url: 'https://cdn.test/solar.png', alt: 'Solar panels' },
      visual: { role: 'hero', intent: 'emphasis', placement: 'full_bleed' },
    });
    expect(result).toEqual({ ok: true });
    const content = editor.getJSON().content ?? [];
    expect(content[0]!.type).toBe('heading');
    expect(content[1]!.type).toBe('image');

    editor.commands.undo();
    expect(JSON.stringify(editor.getJSON()).includes('"type":"image"')).toBe(false);
  });
});

describe('background targeting (R4.4)', () => {
  function makeEditorWith(content: JSONContent[]): Editor {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: { type: 'doc', content },
    });
    editors.push(editor);
    return editor;
  }

  it('reads the page-hero region as the hero host for a background', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(CURSOR_IN_SECOND);
    expect(readEditorBackgroundTarget(editor)).toEqual({
      kind: 'hero',
      heroPath: [0],
      anchorPath: [0],
      nodeType: 'heading',
      placement: 'full_bleed',
      heading: 'Solar energy',
      supportingText: 'Solar panels store energy. Battery storage holds charge.',
    });
  });

  it('reads a section host for a heading-delimited region below the hero', () => {
    const editor = makeEditorWith([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Intro' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Intro text.' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Solar energy' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Solar panels store energy.' }] },
    ]);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(readEditorBackgroundTarget(editor)).toEqual({
      kind: 'section',
      sectionPath: [2],
      anchorPath: [2],
      heading: 'Solar energy',
    });
  });

  it('prefers an explicit composition hero the selection sits in', () => {
    const editor = makeEditorWith([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Page title' }] },
      {
        type: 'compositionHero',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Storage' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Batteries hold charge.' }] },
        ],
      },
    ]);
    editor.commands.setTextSelection(15);
    expect(readEditorBackgroundTarget(editor)).toEqual({
      kind: 'hero',
      heroPath: [1],
      anchorPath: [1, 0],
      nodeType: 'compositionHero',
      placement: 'full_bleed',
      heading: 'Storage',
      supportingText: 'Batteries hold charge.',
    });
  });

  it('returns null when the document has no section or hero to host it', () => {
    const editor = makeEditorWith([{ type: 'paragraph', content: [{ type: 'text', text: 'Just prose.' }] }]);
    editor.commands.setTextSelection(3);
    expect(readEditorBackgroundTarget(editor)).toBeNull();
  });

  it('carries the background host hint into the transmitted context', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(CURSOR_IN_SECOND);
    const context = imageInsertionContextFromSnapshot(snapshotOf(editor), readEditorImageSemantics(editor));
    expect(context?.backgroundTarget).toMatchObject({ kind: 'hero', heroPath: [0], anchorPath: [0] });
  });

  it('inserts a background image after the host heading and undo removes it', () => {
    const editor = makeEditor();
    const result = applyImageInsertionOperation(editor, {
      type: 'insert_image',
      target: { kind: 'section', sectionPath: [0], anchorPath: [0] },
      image: { assetId: 'm1', url: 'https://cdn.test/solar.png', alt: '' },
      visual: { role: 'background', intent: 'atmosphere', placement: 'full_bleed' },
    });
    expect(result).toEqual({ ok: true });
    const content = editor.getJSON().content ?? [];
    expect(content[0]!.type).toBe('heading');
    expect(content[1]!.type).toBe('image');

    editor.commands.undo();
    expect(JSON.stringify(editor.getJSON()).includes('"type":"image"')).toBe(false);
  });
});
