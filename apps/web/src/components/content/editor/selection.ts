import type { Editor } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import type { Node as PmNode } from '@tiptap/pm/model';
import { resolveElementType } from './elementRegistry';
import type { EditorSelection } from './types';

function idOf(node: PmNode): string | undefined {
  const value = node.attrs?.id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pathFromPos(doc: PmNode, pos: number): number[] {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  const path: number[] = [];
  for (let depth = 0; depth <= $pos.depth; depth += 1) {
    path.push($pos.index(depth));
  }
  return path;
}

function fromNode(doc: PmNode, node: PmNode, pos: number): EditorSelection {
  return {
    type: resolveElementType(node.type.name),
    id: idOf(node),
    path: pathFromPos(doc, pos),
  };
}

/** Maps the live Tiptap selection onto editor-level element selection. */
export function readCanvasSelection(editor: Editor): EditorSelection {
  const { selection, doc } = editor.state;
  if (selection instanceof NodeSelection) {
    return fromNode(doc, selection.node, selection.from);
  }

  const $from = selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'doc') continue;
    return fromNode(doc, node, $from.before(depth));
  }

  const after = $from.nodeAfter;
  if (after) return fromNode(doc, after, $from.pos);
  return null;
}
