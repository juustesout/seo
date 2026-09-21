import type { Editor } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import type { Node as PmNode } from '@tiptap/pm/model';
import { resolveElementType } from './elementRegistry';
import type { EditorSelection } from './types';
import type { EditorSelectionSnapshot } from './editorContext';

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

/** Nearest non-document ancestor of a position: the block the cursor is in. */
function containingBlock($from: { depth: number; node: (depth: number) => PmNode; before: (depth: number) => number }): {
  node: PmNode;
  pos: number;
} | null {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'doc') continue;
    return { node, pos: $from.before(depth) };
  }
  return null;
}

function withNodeContext(snapshot: EditorSelectionSnapshot, node: PmNode, pos: number, doc: PmNode): EditorSelectionSnapshot {
  snapshot.nodeType = node.type.name;
  snapshot.nodePath = pathFromPos(doc, pos);
  const id = idOf(node);
  if (id) snapshot.blockId = id;
  return snapshot;
}

/**
 * Normalizes the live Tiptap selection into a document-scoped snapshot for
 * consumers. Returns `{ type: 'none' }` when there is no usable editor. Node
 * paths are structural (transient), and `blockId` is only reported when the
 * node already carries one - nothing is fabricated.
 */
export function readSelectionSnapshot(editor: Editor | null): EditorSelectionSnapshot {
  if (!editor || editor.isDestroyed) return { type: 'none' };
  const { selection, doc } = editor.state;

  if (selection instanceof NodeSelection) {
    const snapshot: EditorSelectionSnapshot = {
      type: 'node',
      from: selection.from,
      to: selection.to,
    };
    return withNodeContext(snapshot, selection.node, selection.from, doc);
  }

  const snapshot: EditorSelectionSnapshot = selection.empty
    ? { type: 'cursor', from: selection.from, to: selection.from }
    : { type: 'text', from: selection.from, to: selection.to };

  const block = containingBlock(selection.$from);
  if (block) withNodeContext(snapshot, block.node, block.pos, doc);
  return snapshot;
}
