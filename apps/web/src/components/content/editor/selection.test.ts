import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { TipDoc } from '@seo/contracts';
import { createEditorExtensions } from './extensions';
import { readCanvasSelection, readSelectionSnapshot } from './selection';

const editors: Editor[] = [];

function makeEditor(content: TipDoc): Editor {
  const editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

describe('readCanvasSelection', () => {
  it('records type and path for nested composition nodes', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'compositionHero',
          content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hero' }] }],
        },
        {
          type: 'compositionCta',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Go' }] }],
        },
      ],
    });

    editor.commands.setTextSelection(3);
    expect(readCanvasSelection(editor)).toEqual(
      expect.objectContaining({ type: 'heading', path: [0, 0] }),
    );

    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    expect(readCanvasSelection(editor)).toEqual(
      expect.objectContaining({ type: 'paragraph', path: [1, 0] }),
    );
  });

  it('aliases hero/cta node names onto registry types', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [{ type: 'compositionHero', content: [{ type: 'paragraph' }] }],
    });
    editor.commands.setNodeSelection(0);
    expect(readCanvasSelection(editor)?.type).toBe('compositionHero');
  });
});

describe('readSelectionSnapshot', () => {
  it('reports none without a usable editor', () => {
    expect(readSelectionSnapshot(null)).toEqual({ type: 'none' });
  });

  it('normalizes a cursor into its containing block', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
    });

    editor.commands.setTextSelection(3);
    expect(readSelectionSnapshot(editor)).toEqual({
      type: 'cursor',
      from: 3,
      to: 3,
      nodeType: 'paragraph',
      nodePath: [0],
    });
  });

  it('normalizes a text range without inventing a block id', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
    });

    editor.commands.setTextSelection({ from: 1, to: 6 });
    const snapshot = readSelectionSnapshot(editor);
    expect(snapshot).toEqual({
      type: 'text',
      from: 1,
      to: 6,
      nodeType: 'paragraph',
      nodePath: [0],
    });
    expect(snapshot.blockId).toBeUndefined();
  });

  it('normalizes a node selection with its structural path', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'compositionHero', content: [{ type: 'paragraph' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
      ],
    });

    editor.commands.setNodeSelection(0);
    expect(readSelectionSnapshot(editor)).toEqual({
      type: 'node',
      from: 0,
      to: expect.any(Number),
      nodeType: 'compositionHero',
      nodePath: [0],
    });
  });

  it('does not leak a block id when the node has none', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [{ type: 'compositionHero', content: [{ type: 'paragraph' }] }],
    });
    editor.commands.setNodeSelection(0);
    expect(readSelectionSnapshot(editor).blockId).toBeUndefined();
  });
});
