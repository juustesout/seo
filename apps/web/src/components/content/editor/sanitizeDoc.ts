import type { TipDoc, TipNode } from '@seo/contracts';
import { COMPOSITION_NODE_TYPES } from './CompositionNodes';

const KNOWN_TYPES = new Set<string>([
  'doc',
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'image',
  'hardBreak',
  'horizontalRule',
  'text',
  ...COMPOSITION_NODE_TYPES,
]);

function isInline(node: TipNode): boolean {
  return node.type === 'text' || node.type === 'hardBreak';
}

function unsupportedParagraph(type: string): TipNode {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text: `[unsupported:${type}]` }],
  };
}

function sanitizeNode(node: TipNode): TipNode[] {
  if (!node || typeof node.type !== 'string' || node.type.length === 0) return [];
  if (node.type === 'text') {
    return [{ type: 'text', text: typeof node.text === 'string' ? node.text : '', marks: node.marks }];
  }
  const children = (node.content ?? []).flatMap(sanitizeNode);
  if (!KNOWN_TYPES.has(node.type)) {
    if (children.length === 0) return [unsupportedParagraph(node.type)];
    const blocks = children.filter((child) => !isInline(child));
    const inlines = children.filter(isInline);
    const out = [...blocks];
    if (inlines.length > 0) out.push({ type: 'paragraph', content: inlines });
    return out;
  }
  if (children.length > 0) return [{ ...node, content: children }];
  const next = { ...node };
  delete next.content;
  return [next];
}

/** Unknown node types are flattened so Tiptap never throws on unsupported composition. */
export function sanitizeEditorDoc(doc: TipDoc | null | undefined): TipDoc {
  const content = Array.isArray(doc?.content) ? doc.content.flatMap(sanitizeNode) : [];
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}
