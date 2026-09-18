import type { Editor } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import type { TipNode } from '@seo/contracts';
import { COMPOSITION_NODE_TYPES, type CompositionNodeType } from './CompositionNodes';
import { resolveElementType } from './elementRegistry';

function paragraph(text?: string): TipNode {
  return text
    ? { type: 'paragraph', content: [{ type: 'text', text }] }
    : { type: 'paragraph' };
}

function heading(level: number, text: string): TipNode {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

export function defaultCompositionNode(type: CompositionNodeType): TipNode {
  switch (type) {
    case 'compositionHero':
      return { type, content: [heading(1, 'Hero'), paragraph()] };
    case 'compositionSection':
      return { type, content: [paragraph()] };
    case 'compositionFeatureCard':
      return { type, content: [heading(3, 'Feature'), paragraph()] };
    case 'compositionFeatureGrid':
      return {
        type,
        content: [
          defaultCompositionNode('compositionFeatureCard'),
          defaultCompositionNode('compositionFeatureCard'),
          defaultCompositionNode('compositionFeatureCard'),
        ],
      };
    case 'compositionCta':
      return { type, content: [paragraph('Call to action')] };
    case 'compositionButton':
      return { type, attrs: { href: null, variant: 'default', layout: null }, content: [{ type: 'text', text: 'Button' }] };
  }
}

function isCompositionType(type: string): type is CompositionNodeType {
  return (COMPOSITION_NODE_TYPES as readonly string[]).includes(type);
}

function depthOfType(editor: Editor, type: string): number {
  const $from = editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === type) return depth;
  }
  return -1;
}

function selectedNodeName(editor: Editor): string | null {
  const { selection } = editor.state;
  return selection instanceof NodeSelection ? selection.node.type.name : null;
}

function tryInsertAt(editor: Editor, pos: number, json: TipNode): boolean {
  const bounded = Math.max(0, Math.min(pos, editor.state.doc.content.size));
  try {
    if (editor.can().insertContentAt(bounded, json) === false) return false;
    return editor.chain().focus().insertContentAt(bounded, json).run();
  } catch {
    return false;
  }
}

function tryInsertContent(editor: Editor, json: TipNode): boolean {
  try {
    if (editor.can().insertContent(json) === false) return false;
    return editor.chain().focus().insertContent(json).run();
  } catch {
    return false;
  }
}

function insertInsideSelected(editor: Editor, json: TipNode): boolean {
  const { selection } = editor.state;
  if (!(selection instanceof NodeSelection)) return false;
  const innerEnd = selection.from + selection.node.nodeSize - 1;
  return tryInsertAt(editor, innerEnd, json);
}

function insertBlockJson(editor: Editor, json: TipNode): boolean {
  const { selection } = editor.state;

  if (selection instanceof NodeSelection) {
    if (tryInsertAt(editor, selection.to, json)) return true;
  } else if (tryInsertContent(editor, json)) {
    return true;
  }

  const $from = selection.$from;
  for (let depth = $from.depth; depth >= 1; depth -= 1) {
    if (tryInsertAt(editor, $from.after(depth), json)) return true;
  }
  return false;
}

function insertFeatureGrid(editor: Editor): boolean {
  const grid = defaultCompositionNode('compositionFeatureGrid');
  if (selectedNodeName(editor) === 'compositionSection') {
    if (insertInsideSelected(editor, grid)) return true;
  }
  const sectionDepth = depthOfType(editor, 'compositionSection');
  if (sectionDepth > 0) {
    const end = editor.state.selection.$from.end(sectionDepth);
    if (tryInsertAt(editor, end, grid)) return true;
    if (tryInsertContent(editor, grid)) return true;
  }
  return insertBlockJson(editor, grid);
}

function insertFeatureCard(editor: Editor): boolean {
  const card = defaultCompositionNode('compositionFeatureCard');
  const selected = selectedNodeName(editor);
  if (selected === 'compositionFeatureGrid') {
    if (insertInsideSelected(editor, card)) return true;
  }
  if (selected === 'compositionFeatureCard') {
    const { selection } = editor.state;
    if (selection instanceof NodeSelection && tryInsertAt(editor, selection.to, card)) return true;
  }
  const cardDepth = depthOfType(editor, 'compositionFeatureCard');
  if (cardDepth > 0) {
    if (tryInsertAt(editor, editor.state.selection.$from.after(cardDepth), card)) return true;
  }
  if (depthOfType(editor, 'compositionFeatureGrid') > 0) {
    if (!(editor.state.selection instanceof NodeSelection) && tryInsertContent(editor, card)) return true;
    const gridDepth = depthOfType(editor, 'compositionFeatureGrid');
    if (tryInsertAt(editor, editor.state.selection.$from.end(gridDepth), card)) return true;
  }
  return insertFeatureGridWithCards(editor, [card]);
}

function insertFeatureGridWithCards(editor: Editor, cards: TipNode[]): boolean {
  const grid: TipNode = { type: 'compositionFeatureGrid', content: cards };
  if (selectedNodeName(editor) === 'compositionSection') {
    if (insertInsideSelected(editor, grid)) return true;
  }
  const sectionDepth = depthOfType(editor, 'compositionSection');
  if (sectionDepth > 0) {
    if (tryInsertAt(editor, editor.state.selection.$from.end(sectionDepth), grid)) return true;
  }
  return insertBlockJson(editor, grid);
}

export function selectInsertedComposition(editor: Editor, type: string): boolean {
  if (editor.isDestroyed) return false;
  const target = resolveElementType(type);
  const { selection, doc } = editor.state;
  const $from = selection.$from;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === target) {
      return editor.chain().setNodeSelection($from.before(depth)).run();
    }
  }

  if (selection instanceof NodeSelection && selection.node.type.name === target) {
    return true;
  }

  const before = $from.nodeBefore;
  if (before?.type.name === target) {
    return editor.chain().setNodeSelection($from.pos - before.nodeSize).run();
  }

  let found = -1;
  let last = -1;
  doc.descendants((node, pos) => {
    if (node.type.name === target) {
      if (found === -1) found = pos;
      last = pos;
    }
    return true;
  });
  const pos = last === -1 ? found : last;
  if (pos === -1) return false;
  return editor.chain().setNodeSelection(pos).run();
}

export function deleteSelectedComposition(editor: Editor): boolean {
  if (editor.isDestroyed) return false;
  const { selection } = editor.state;
  if (!(selection instanceof NodeSelection)) return false;
  if (!isCompositionType(selection.node.type.name)) return false;
  return editor.chain().focus().deleteSelection().run();
}

/** Inserts a composition node, wrapping FeatureCard in a FeatureGrid when needed. */
export function insertComposition(editor: Editor, type: string): boolean {
  if (editor.isDestroyed) return false;
  const resolved = resolveElementType(type);
  if (!isCompositionType(resolved)) return false;
  if (resolved === 'compositionFeatureCard') return insertFeatureCard(editor);
  if (resolved === 'compositionFeatureGrid') return insertFeatureGrid(editor);
  return insertBlockJson(editor, defaultCompositionNode(resolved));
}
