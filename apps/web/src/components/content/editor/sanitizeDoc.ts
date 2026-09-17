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

function emptyParagraph(): TipNode {
  return { type: 'paragraph' };
}

function emptyCard(): TipNode {
  return { type: 'compositionFeatureCard', content: [emptyParagraph()] };
}

function repairComposition(type: string, children: TipNode[]): TipNode[] {
  if (type === 'compositionFeatureGrid') {
    const cards = children.filter((child) => child.type === 'compositionFeatureCard');
    return [{ type, content: cards.length > 0 ? cards : [emptyCard()] }];
  }
  if (type === 'compositionFeatureCard' || type === 'compositionSection') {
    return [{ type, content: children.length > 0 ? children : [emptyParagraph()] }];
  }
  if (children.length > 0) return [{ type, content: children }];
  return [{ type }];
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
  if ((COMPOSITION_NODE_TYPES as readonly string[]).includes(node.type)) {
    return repairComposition(node.type, children);
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
