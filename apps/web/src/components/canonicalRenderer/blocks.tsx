/**
 * Canonical block renderer registry.
 *
 * One renderer per semantic block type, dispatched by `type` through a lookup
 * table, so new composition blocks can be added independently of this file
 * (register a function; no conditional tree to edit). Every renderer consumes
 * the shared {@link RenderContext} and produces semantic HTML; presentation
 * lives in `canonicalRenderer.css`, driven by the scoped `--cosmos-*` tokens.
 *
 * Unknown / custom blocks fall through to `renderCanonicalFallback`, which
 * preserves children and inline text, and renders preserved `rawHtml` as
 * escaped text - never injected as live markup.
 */

import { createElement, type ReactNode } from 'react';
import type { CanonicalBlock, CanonicalInline, CanonicalText } from '@seo/contracts';
import type { BlockRenderer, RenderContext } from './context';
import { blockClassNames, classNames, columnsClassNames } from './presentation';
import { safeHref, safeImageSrc } from './safety';

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
type HeadingLevel = (typeof HEADING_LEVELS)[number];

function headingLevel(value: unknown): HeadingLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6
    ? (value as HeadingLevel)
    : 2;
}

function inlineTextOf(content: CanonicalInline[] | undefined): string {
  if (!content) return '';
  return content
    .map((node) => (node.type === 'text' ? (node as CanonicalText).text : ''))
    .join('');
}

function childrenOrInline(block: CanonicalBlock, keyPrefix: string, ctx: RenderContext): ReactNode {
  const children = block.children ?? [];
  if (children.length > 0) return ctx.renderBlocks(children, `${keyPrefix}c`);
  return ctx.renderInline(block.content);
}

function stringAttr(block: CanonicalBlock, key: string): string | undefined {
  const value = block.attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function iconElement(block: CanonicalBlock, className: string): ReactNode {
  const icon = stringAttr(block, 'icon');
  if (!icon) return null;
  return <span className={className} data-cosmos-icon={icon} aria-hidden="true" />;
}

const contentRenderers: Record<string, BlockRenderer> = {
  paragraph: (block, ctx) => <p className={classNames(...blockClassNames(block))}>{ctx.renderInline(block.content)}</p>,

  heading: (block, ctx) =>
    createElement(
      `h${headingLevel(block.attrs?.level)}`,
      { className: classNames(...blockClassNames(block)) },
      ctx.renderInline(block.content),
    ),

  list: (block, ctx) => {
    const ordered = block.attrs?.ordered === true;
    const start = typeof block.attrs?.start === 'number' ? block.attrs.start : undefined;
    return createElement(
      ordered ? 'ol' : 'ul',
      { className: classNames(...blockClassNames(block)), start: ordered ? start : undefined },
      ctx.renderBlocks(block.children, 'li'),
    );
  },

  listItem: (block, ctx) => (
    <li className={classNames(...blockClassNames(block))}>{childrenOrInline(block, 'i', ctx)}</li>
  ),

  quote: (block, ctx) => (
    <blockquote className={classNames(...blockClassNames(block))}>{childrenOrInline(block, 'q', ctx)}</blockquote>
  ),

  code: (block) => (
    <pre className={classNames(...blockClassNames(block))} data-language={stringAttr(block, 'language')}>
      <code>{inlineTextOf(block.content)}</code>
    </pre>
  ),

  image: (block) => {
    const src = safeImageSrc(block.attrs?.src);
    const alt = stringAttr(block, 'alt') ?? '';
    const caption = stringAttr(block, 'caption');
    const width = typeof block.attrs?.width === 'number' ? block.attrs.width : undefined;
    const height = typeof block.attrs?.height === 'number' ? block.attrs.height : undefined;
    return (
      <figure className={classNames(...blockClassNames(block))}>
        {src ? (
          <img src={src} alt={alt} width={width} height={height} loading="lazy" />
        ) : (
          <span className="cosmos-image__missing" role="img" aria-label={alt || 'image unavailable'}>
            {`[image${alt ? `: ${alt}` : ''}]`}
          </span>
        )}
        {caption ? <figcaption>{caption}</figcaption> : null}
      </figure>
    );
  },

  divider: (block) => <hr className={classNames(...blockClassNames(block))} />,

  table: (block, ctx) => (
    <table className={classNames(...blockClassNames(block))}>
      <tbody>{ctx.renderBlocks(block.children, 'r')}</tbody>
    </table>
  ),

  tableRow: (block, ctx) => <tr className={classNames(...blockClassNames(block))}>{ctx.renderBlocks(block.children, 'c')}</tr>,

  tableCell: (block, ctx) => (
    <td className={classNames(...blockClassNames(block))}>{childrenOrInline(block, 'c', ctx)}</td>
  ),

  group: (block, ctx) => <div className={classNames(...blockClassNames(block))}>{ctx.renderBlocks(block.children, 'g')}</div>,

  columns: (block, ctx) => {
    const count = Math.max(1, (block.children ?? []).length);
    return (
      <div className={classNames(...blockClassNames(block), ...columnsClassNames(count))}>
        {ctx.renderBlocks(block.children, 'c')}
      </div>
    );
  },

  column: (block, ctx) => <div className={classNames(...blockClassNames(block))}>{ctx.renderBlocks(block.children, 'c')}</div>,

  embed: (block, ctx) => {
    const url = safeHref(block.attrs?.url);
    if (url) {
      return (
        <p className={classNames(...blockClassNames(block))}>
          <a href={url} target="_blank" rel="noopener noreferrer">
            {url}
          </a>
        </p>
      );
    }
    return childrenOrInline(block, 'e', ctx);
  },
};

const compositionRenderers: Record<string, BlockRenderer> = {
  hero: (block, ctx) => (
    <section className={classNames(...blockClassNames(block))}>{ctx.renderBlocks(block.children, 'h')}</section>
  ),

  section: (block, ctx) => (
    <section className={classNames(...blockClassNames(block))}>{ctx.renderBlocks(block.children, 's')}</section>
  ),

  featureGrid: (block, ctx) => (
    <div role="list" className={classNames(...blockClassNames(block))}>
      {ctx.renderBlocks(block.children, 'f')}
    </div>
  ),

  featureCard: (block, ctx) => (
    <div role="listitem" className={classNames(...blockClassNames(block))}>
      {iconElement(block, 'cosmos-feature-card__icon')}
      {ctx.renderBlocks(block.children, 'f')}
    </div>
  ),

  cta: (block, ctx) => (
    <section className={classNames(...blockClassNames(block))}>{ctx.renderBlocks(block.children, 'c')}</section>
  ),

  callout: (block, ctx) => (
    <aside role="note" className={classNames(...blockClassNames(block))}>
      {iconElement(block, 'cosmos-callout__icon')}
      {ctx.renderBlocks(block.children, 'c')}
    </aside>
  ),

  testimonial: (block, ctx) => (
    <figure className={classNames(...blockClassNames(block))}>{ctx.renderBlocks(block.children, 't')}</figure>
  ),

  stats: (block, ctx) => (
    <dl className={classNames(...blockClassNames(block))}>{ctx.renderBlocks(block.children, 's')}</dl>
  ),

  statItem: (block, ctx) => {
    const value = stringAttr(block, 'value');
    return (
      <div className={classNames(...blockClassNames(block))}>
        {value !== undefined ? <dt className="cosmos-stat__value">{value}</dt> : null}
        <dd className="cosmos-stat__label">{ctx.renderInline(block.content)}</dd>
      </div>
    );
  },

  mediaText: (block, ctx) => (
    <div className={classNames(...blockClassNames(block))}>{ctx.renderBlocks(block.children, 'm')}</div>
  ),

  badge: (block, ctx) => (
    <span className={classNames(...blockClassNames(block))}>{ctx.renderInline(block.content)}</span>
  ),

  button: (block, ctx) => {
    const href = safeHref(block.attrs?.href);
    const className = classNames(...blockClassNames(block));
    const label = ctx.renderInline(block.content);
    return href ? (
      <a className={className} href={href}>
        {label}
      </a>
    ) : (
      <span className={className}>{label}</span>
    );
  },

  footer: (block, ctx) => (
    <footer className={classNames(...blockClassNames(block))}>{ctx.renderBlocks(block.children, 'f')}</footer>
  ),
};

const registry: Record<string, BlockRenderer> = { ...contentRenderers, ...compositionRenderers };

/** True when a renderer (content or composition) is registered for a type. */
export function hasCanonicalBlockRenderer(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry, type);
}

/** Safe fallback: preserve children, then inline text, then escaped raw HTML. */
export function renderCanonicalFallback(block: CanonicalBlock, ctx: RenderContext): ReactNode {
  const label = block.source?.type ?? block.type;
  const className = classNames(...blockClassNames(block), 'cosmos-unsupported');
  const children = block.children ?? [];
  if (children.length > 0) {
    return (
      <div className={className} data-cosmos-unsupported={label}>
        {ctx.renderBlocks(children, 'u')}
      </div>
    );
  }
  if (block.content && block.content.length > 0) {
    return (
      <div className={className} data-cosmos-unsupported={label}>
        {ctx.renderInline(block.content)}
      </div>
    );
  }
  if (typeof block.rawHtml === 'string' && block.rawHtml.length > 0) {
    // Escaped text, not markup: preserved content stays visible without ever
    // becoming an HTML/script execution surface.
    return (
      <div className={className} data-cosmos-unsupported={label}>
        {block.rawHtml}
      </div>
    );
  }
  return (
    <div className={className} data-cosmos-unsupported={label}>
      {`[unsupported:${label}]`}
    </div>
  );
}

/** Dispatch a block to its registered renderer, or the safe fallback. */
export function renderCanonicalBlock(block: CanonicalBlock, ctx: RenderContext): ReactNode {
  const renderer = registry[block.type];
  return renderer ? renderer(block, ctx) : renderCanonicalFallback(block, ctx);
}
