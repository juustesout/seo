/**
 * Renderer context passed to every block renderer.
 *
 * Blocks never reach into globals or the design system themselves: the root
 * renderer supplies the resolved design system plus the recursive helpers, so a
 * new block renderer can be added to the registry without touching the tree.
 */

import type { ReactNode } from 'react';
import type { CanonicalBlock, CanonicalInline, DesignSystem } from '@seo/contracts';

export interface RenderContext {
  designSystem: DesignSystem;
  renderInline: (content: CanonicalInline[] | undefined) => ReactNode;
  renderBlocks: (blocks: CanonicalBlock[] | undefined, keyPrefix: string) => ReactNode;
  /** Children when present, otherwise inline content (leaf-vs-container helper). */
  childrenOrInline: (block: CanonicalBlock, keyPrefix: string) => ReactNode;
}

export type BlockRenderer = (block: CanonicalBlock, ctx: RenderContext) => ReactNode;
