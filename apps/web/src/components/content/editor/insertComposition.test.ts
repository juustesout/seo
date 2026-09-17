import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { TipDoc, TipNode } from '@seo/contracts';
import { createEditorExtensions } from './extensions';
import { insertComposition } from './insertComposition';

const editors: Editor[] = [];

function makeEditor(content?: TipDoc): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions({ nodeViews: false }),
    content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  editors.push(editor);
  return editor;
}

function types(node: TipNode | undefined): string[] {
  if (!node) return [];
  return [node.type, ...(node.content ?? []).flatMap(types)];
}

afterEach(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

describe('insertComposition', () => {
  it('inserts a FeatureGrid with three FeatureCards', () => {
    const editor = makeEditor();
    expect(insertComposition(editor, 'compositionFeatureGrid')).toBe(true);
    const json = editor.getJSON() as TipDoc;
    expect(types(json.content?.[0]).filter((type) => type !== 'text')).toEqual([
      'compositionFeatureGrid',
      'compositionFeatureCard',
      'heading',
      'paragraph',
      'compositionFeatureCard',
      'heading',
      'paragraph',
      'compositionFeatureCard',
      'heading',
      'paragraph',
    ]);
  });

  it('wraps a FeatureCard in a FeatureGrid when inserted at the document root', () => {
    const editor = makeEditor();
    expect(insertComposition(editor, 'compositionFeatureCard')).toBe(true);
    const json = editor.getJSON() as TipDoc;
    expect(json.content?.[0]?.type).toBe('compositionFeatureGrid');
    expect(json.content?.[0]?.content?.[0]?.type).toBe('compositionFeatureCard');
  });

  it('adds another FeatureCard inside an existing FeatureGrid', () => {
    const editor = makeEditor();
    insertComposition(editor, 'compositionFeatureGrid');
    expect(insertComposition(editor, 'compositionFeatureCard')).toBe(true);
    const grid = (editor.getJSON() as TipDoc).content?.[0];
    expect(grid?.content).toHaveLength(4);
    expect(grid?.content?.every((node) => node.type === 'compositionFeatureCard')).toBe(true);
  });
});
