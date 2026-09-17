import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { TipDoc, TipNode } from '@seo/contracts';
import { createEditorExtensions } from './extensions';
import {
  deleteSelectedComposition,
  insertComposition,
  selectInsertedComposition,
} from './insertComposition';
import { readCanvasSelection } from './selection';

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

function findType(node: TipNode | undefined, type: string): TipNode | undefined {
  if (!node) return undefined;
  if (node.type === type) return node;
  return node.content?.map((child) => findType(child, type)).find(Boolean);
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

  it('inserts a Section that can hold a FeatureGrid', () => {
    const editor = makeEditor();
    expect(insertComposition(editor, 'compositionSection')).toBe(true);
    selectInsertedComposition(editor, 'compositionSection');
    expect(insertComposition(editor, 'compositionFeatureGrid')).toBe(true);
    const json = editor.getJSON() as TipDoc;
    const section = json.content?.find((node) => node.type === 'compositionSection');
    const nested = section?.content?.find((node) => node.type === 'compositionFeatureGrid');
    expect(nested?.type).toBe('compositionFeatureGrid');
    expect(nested?.content?.every((node) => node.type === 'compositionFeatureCard')).toBe(true);
  });

  it('places a FeatureCard inside a FeatureGrid nested in a Section', () => {
    const editor = makeEditor();
    insertComposition(editor, 'compositionSection');
    selectInsertedComposition(editor, 'compositionSection');
    insertComposition(editor, 'compositionFeatureGrid');
    selectInsertedComposition(editor, 'compositionFeatureGrid');
    expect(insertComposition(editor, 'compositionFeatureCard')).toBe(true);
    const section = (editor.getJSON() as TipDoc).content?.find((node) => node.type === 'compositionSection');
    const grid = section?.content?.find((node) => node.type === 'compositionFeatureGrid');
    expect(grid?.content?.every((node) => node.type === 'compositionFeatureCard')).toBe(true);
    expect((grid?.content ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('selects the inserted composition node with type and path', () => {
    const editor = makeEditor();
    expect(insertComposition(editor, 'compositionHero')).toBe(true);
    expect(selectInsertedComposition(editor, 'compositionHero')).toBe(true);
    expect(readCanvasSelection(editor)).toEqual(
      expect.objectContaining({ type: 'compositionHero', path: expect.any(Array) }),
    );
  });

  it('does not replace an existing Hero when inserting a Section', () => {
    const editor = makeEditor();
    insertComposition(editor, 'compositionHero');
    selectInsertedComposition(editor, 'compositionHero');
    expect(insertComposition(editor, 'compositionSection')).toBe(true);
    const typesAtRoot = ((editor.getJSON() as TipDoc).content ?? []).map((node) => node.type);
    expect(typesAtRoot).toContain('compositionHero');
    expect(typesAtRoot).toContain('compositionSection');
  });

  it('keeps FeatureGrid children valid when a Hero cannot nest inside it', () => {
    const editor = makeEditor();
    insertComposition(editor, 'compositionFeatureGrid');
    selectInsertedComposition(editor, 'compositionFeatureGrid');
    const before = editor.getJSON() as TipDoc;
    insertComposition(editor, 'compositionHero');
    const after = editor.getJSON() as TipDoc;
    const grid = findType(after, 'compositionFeatureGrid');
    expect(grid?.content?.every((node) => node.type === 'compositionFeatureCard')).toBe(true);
    expect(after.content?.some((node) => node.type === 'compositionHero') || before.content?.length === after.content?.length).toBe(
      true,
    );
  });

  it('undo and redo restore inserted composition nodes', () => {
    const editor = makeEditor();
    insertComposition(editor, 'compositionCta');
    expect((editor.getJSON() as TipDoc).content?.some((node) => node.type === 'compositionCta')).toBe(true);
    editor.commands.undo();
    expect((editor.getJSON() as TipDoc).content?.some((node) => node.type === 'compositionCta')).toBe(false);
    editor.commands.redo();
    expect((editor.getJSON() as TipDoc).content?.some((node) => node.type === 'compositionCta')).toBe(true);
  });

  it('deletes a selected composition node', () => {
    const editor = makeEditor();
    insertComposition(editor, 'compositionHero');
    selectInsertedComposition(editor, 'compositionHero');
    expect(deleteSelectedComposition(editor)).toBe(true);
    expect((editor.getJSON() as TipDoc).content?.some((node) => node.type === 'compositionHero')).toBe(false);
  });
});
