/**
 * Review-before-apply panel for one Cosmos AI editor operation.
 *
 * The API returns a validated `replace_selection` proposal (validated Tiptap
 * blocks + reason + model + optional knowledge). Nothing is applied until the
 * user presses Apply; Reject simply discards it. The panel renders a read-only
 * preview of the proposed blocks.
 */
import { createElement, type ReactNode } from 'react';
import type { ContentAiEditResponseDto, TipNode } from '@seo/contracts';
import { Button } from '@/components/ui/button';

function renderNodes(nodes: TipNode[], prefix: string): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, `${prefix}-${index}`));
}

function renderNode(node: TipNode, key: string): ReactNode {
  const children = node.content ? renderNodes(node.content, key) : node.text ?? null;
  switch (node.type) {
    case 'text':
      return createElement('span', { key }, node.text ?? '');
    case 'paragraph':
      return createElement('p', { key }, children);
    case 'heading': {
      const level = Number((node.attrs as { level?: unknown } | undefined)?.level ?? 2);
      const tag = `h${Math.min(6, Math.max(1, Number.isFinite(level) ? level : 2))}`;
      return createElement(tag, { key }, children);
    }
    case 'bulletList':
      return createElement('ul', { key, className: 'list-disc pl-5' }, children);
    case 'orderedList':
      return createElement('ol', { key, className: 'list-decimal pl-5' }, children);
    case 'listItem':
      return createElement('li', { key }, children);
    case 'blockquote':
      return createElement('blockquote', { key, className: 'border-l-2 pl-3 text-muted-foreground' }, children);
    case 'codeBlock':
      return createElement('pre', { key, className: 'rounded bg-muted/50 p-2' }, children);
    case 'hardBreak':
      return createElement('br', { key });
    default:
      return createElement('div', { key }, children);
  }
}

interface ContentAiEditPanelProps {
  proposal: ContentAiEditResponseDto;
  /** Human label for the requested operation (e.g. "Rewrite", "Ask AI"). */
  operationLabel: string;
  onApply: () => void;
  onReject: () => void;
}

export function ContentAiEditPanel({ proposal, operationLabel, onApply, onReject }: ContentAiEditPanelProps) {
  return (
    <div className="rounded-[10px] border border-l-[3px] border-l-primary bg-card px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <strong>AI edit — {operationLabel}</strong>
        <span className="font-mono text-xs text-muted-foreground">{proposal.model}</span>
      </div>
      {proposal.knowledge && proposal.knowledge.length > 0 && (
        <p className="my-1.5 text-xs text-muted-foreground">
          Using {proposal.knowledge.length} knowledge source{proposal.knowledge.length === 1 ? '' : 's'} as context.
        </p>
      )}
      {proposal.reason && <p className="my-2 text-sm text-muted-foreground">{proposal.reason}</p>}
      <div className="mt-2 max-h-[300px] overflow-auto rounded-lg border bg-muted/40 px-3 py-2.5 text-sm [&_h2]:my-1 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:my-1 [&_h3]:text-sm [&_h3]:font-semibold [&_p]:my-1">
        {renderNodes(proposal.content, 'proposal')}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onApply}>
          Apply
        </Button>
        <Button variant="outline" size="sm" onClick={onReject}>
          Reject
        </Button>
        <span className="text-xs text-muted-foreground">
          AI never edits your document automatically — review before you apply. Undo stays available afterwards.
        </span>
      </div>
    </div>
  );
}
