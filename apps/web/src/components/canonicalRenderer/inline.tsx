/**
 * Inline rendering for the canonical renderer.
 *
 * Inline content maps to semantic inline elements; unknown marks are dropped
 * without losing the text, and unsupported inline nodes surface as an explicit,
 * visible marker rather than silently disappearing.
 */

import { Fragment, type ReactNode } from 'react';
import type { CanonicalInline, CanonicalMark } from '@seo/contracts';
import { safeHref } from './safety';

export function renderInlineNodes(content: CanonicalInline[] | undefined): ReactNode {
  if (!content || content.length === 0) return null;
  return content.map((node, index) => <Fragment key={index}>{renderInlineNode(node)}</Fragment>);
}

function renderInlineNode(node: CanonicalInline): ReactNode {
  if (node.type === 'break') return <br />;
  if (node.type === 'inlineUnsupported') {
    const label = node.source?.type ? `[unsupported:${node.source.type}]` : '[unsupported]';
    return (
      <span className="cosmos-inline-unsupported" data-cosmos-inline="unsupported">
        {label}
      </span>
    );
  }
  let element: ReactNode = node.text;
  for (const mark of node.marks ?? []) element = applyMark(mark, element);
  return element;
}

function applyMark(mark: CanonicalMark, child: ReactNode): ReactNode {
  switch (mark.type) {
    case 'bold':
      return <strong>{child}</strong>;
    case 'italic':
      return <em>{child}</em>;
    case 'strike':
      return <s>{child}</s>;
    case 'code':
      return <code>{child}</code>;
    case 'underline':
      return <u>{child}</u>;
    case 'sub':
      return <sub>{child}</sub>;
    case 'sup':
      return <sup>{child}</sup>;
    case 'link': {
      const href = safeHref(mark.attrs?.href);
      if (!href) return child;
      const target = mark.attrs?.target === '_blank' ? '_blank' : undefined;
      return (
        <a href={href} target={target} rel={target ? 'noopener noreferrer' : undefined}>
          {child}
        </a>
      );
    }
    default:
      return child;
  }
}
