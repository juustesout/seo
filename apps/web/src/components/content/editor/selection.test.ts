import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { TipDoc } from '@seo/contracts';
import { createEditorExtensions } from './extensions';
import { readCanvasSelection } from './selection';

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
