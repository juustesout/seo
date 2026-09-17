import type { Editor } from '@tiptap/react';
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

function insertFeatureCard(editor: Editor): boolean {
  const card = defaultCompositionNode('compositionFeatureCard');
  const cardDepth = depthOfType(editor, 'compositionFeatureCard');
  if (cardDepth > 0) {
    const after = editor.state.selection.$from.after(cardDepth);
    return editor.chain().focus().insertContentAt(after, card).run();
  }
  if (depthOfType(editor, 'compositionFeatureGrid') > 0) {
    return editor.chain().focus().insertContent(card).run();
  }
  return editor
    .chain()
    .focus()
    .insertContent({ type: 'compositionFeatureGrid', content: [card] })
    .run();
}

/** Inserts a composition node, wrapping FeatureCard in a FeatureGrid when needed. */
export function insertComposition(editor: Editor, type: string): boolean {
  if (editor.isDestroyed) return false;
  const resolved = resolveElementType(type);
  if (!isCompositionType(resolved)) return false;
  if (resolved === 'compositionFeatureCard') return insertFeatureCard(editor);
  return editor.chain().focus().insertContent(defaultCompositionNode(resolved)).run();
}
