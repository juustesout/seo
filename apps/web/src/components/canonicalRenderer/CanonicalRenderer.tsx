/**
 * Canonical document renderer (Stage 5).
 *
 * Renders a CMS-neutral CanonicalDocument against a resolved Cosmos design
 * system. The document carries structure and bounded visual intent only; this
 * boundary owns every presentation decision (tokens, layout, responsive
 * behaviour) and expresses it as `--cosmos-*` custom properties scoped to one
 * container. Rendering a document therefore never mutates global application
 * styling, and the report is deterministic: same document + same tokens = same
 * output.
 *
 * The contracts package stays React-free; this renderer is a web concern.
 */

import { Fragment, type CSSProperties, type ReactNode } from 'react';
import {
  designSystemCssVariables,
  effectiveDesignSystem,
  type CanonicalBlock,
  type CanonicalDocument,
  type CanonicalInline,
  type DesignSystem,
} from '@seo/contracts';
import { renderCanonicalBlock } from './blocks';
import { renderInlineNodes } from './inline';
import { classNames } from './presentation';
import type { RenderContext } from './context';
import { useDesignSystem } from '../../lib/designSystem';
import './canonicalRenderer.css';

export interface CanonicalRendererProps {
  document: CanonicalDocument;
  /**
   * Resolved Cosmos design system. Defaults to the effective system from the
   * surrounding `DesignSystemProvider`, then to the safe built-in token set.
   */
  designSystem?: DesignSystem;
  className?: string;
}

function createContext(designSystem: DesignSystem): RenderContext {
  const context = {} as RenderContext;
  context.designSystem = designSystem;
  context.renderInline = (content: CanonicalInline[] | undefined) => renderInlineNodes(content);
  context.renderBlocks = (blocks: CanonicalBlock[] | undefined, keyPrefix: string) =>
    (blocks ?? []).map((block, index) => (
      <Fragment key={`${keyPrefix}${index}`}>{renderCanonicalBlock(block, context)}</Fragment>
    ));
  context.childrenOrInline = (block: CanonicalBlock, keyPrefix: string) => {
    const children = block.children ?? [];
    return children.length > 0 ? context.renderBlocks(children, keyPrefix) : context.renderInline(block.content);
  };
  return context;
}

export function CanonicalRenderer({ document, designSystem, className }: CanonicalRendererProps) {
  const contextDesignSystem = useDesignSystem();
  const resolved = effectiveDesignSystem(designSystem ?? contextDesignSystem);
  const context = createContext(resolved);
  const style = designSystemCssVariables(resolved) as CSSProperties;
  return (
    <div
      className={classNames('cosmos-doc', className)}
      style={style}
      data-cosmos-document={document.version}
      data-cosmos-design-system={document.meta?.designSystem?.id}
    >
      <div className="cosmos-container">{context.renderBlocks(document.blocks, 'b')}</div>
    </div>
  );
}

/** Functional entry point mirroring the conceptual renderer API. */
export function renderCanonicalDocument(document: CanonicalDocument, designSystem?: DesignSystem): ReactNode {
  return <CanonicalRenderer document={document} designSystem={designSystem} />;
}
