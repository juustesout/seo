/**
 * Shared presentation bridge for composition editing (Stage 8E.5).
 *
 * The editor is not a second renderer: it reuses the CanonicalRenderer's own
 * presentation helpers. Editor composition nodes map back to their canonical
 * composition type and ask the canonical {@link blockClassNames} for the class
 * tokens, so the editable canvas and the published preview share exactly one
 * source of geometry (grid, cards, surfaces, layout intent).
 */

import type { CanonicalBlock, TipDoc, TipNode } from '@seo/contracts';
import { blockClassNames } from '../../canonicalRenderer/presentation';

/** Editor composition node -> canonical composition block type. */
const CANONICAL_TYPE_BY_EDITOR_NODE: Record<string, string> = {
  compositionHero: 'hero',
  compositionSection: 'section',
  compositionFeatureGrid: 'featureGrid',
  compositionFeatureCard: 'featureCard',
  compositionCta: 'cta',
  compositionButton: 'button',
};

const EDITOR_NODE_TYPES = new Set(Object.keys(CANONICAL_TYPE_BY_EDITOR_NODE));

/** True when the editor node carries canonical composition structure. */
export function isCompositionEditorNode(type: string): boolean {
  return EDITOR_NODE_TYPES.has(type);
}

/**
 * Canonical class tokens for one editor composition node. Returns an empty
 * string for non-composition nodes so callers can append it unconditionally.
 */
export function compositionBlockClassNames(
  editorType: string,
  attrs?: Record<string, unknown> | null,
): string {
  const canonicalType = CANONICAL_TYPE_BY_EDITOR_NODE[editorType];
  if (!canonicalType) return '';
  const block: CanonicalBlock = { type: canonicalType, attrs: attrs ?? undefined };
  return blockClassNames(block).join(' ');
}

/** True when a document contains composition nodes anywhere in its tree. */
export function hasCompositionNodes(doc: TipDoc | null | undefined): boolean {
  const walk = (nodes: TipNode[] | undefined): boolean =>
    (nodes ?? []).some(
      (node) => isCompositionEditorNode(node.type) || walk(node.content),
    );
  return walk(doc?.content);
}

/**
 * Page mode is a property of the document, not a UI toggle: a document whose
 * structure is composition renders on the page canvas; a legacy article keeps
 * the article/prose surface.
 */
export function canvasModeForDocument(doc: TipDoc | null | undefined): 'page' | 'article' {
  return hasCompositionNodes(doc) ? 'page' : 'article';
}
