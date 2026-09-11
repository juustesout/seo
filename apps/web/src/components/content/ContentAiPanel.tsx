/**
 * Review-before-apply panel for a Content Studio AI suggestion.
 *
 * Content AI never edits the document on its own: the API returns a structured
 * suggestion (model, optional knowledge sources used as context, reason, and
 * the proposed text) and this panel previews it. Applying is an explicit user
 * action that goes through the parent, so the editor's undo history still
 * works after an apply.
 */
import type { ContentAiSuggestionDto } from '@seo/contracts';
import { AI_ACTION_LABELS } from './contentAi';
import { Button } from '@/components/ui/button';

interface ContentAiPanelProps {
  suggestion: ContentAiSuggestionDto;
  onApply: () => void;
  onReject: () => void;
}

/** Review-before-apply panel for an AI suggestion. Never auto-applies. */
export function ContentAiPanel({ suggestion, onApply, onReject }: ContentAiPanelProps) {
  return (
    <div className="rounded-[10px] border border-l-[3px] border-l-primary bg-card px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <strong>AI suggestion — {AI_ACTION_LABELS[suggestion.action]}</strong>
        <span className="font-mono text-xs text-muted-foreground">{suggestion.model}</span>
      </div>
      {suggestion.source && (
        <details className="[&_summary]:cursor-pointer [&_summary]:text-xs [&_summary]:text-muted-foreground">
          <summary>Original selection</summary>
          <div className="mt-1.5 max-h-[300px] overflow-auto rounded-lg border bg-muted/40 px-3 py-2.5 whitespace-pre-wrap">
            {suggestion.source}
          </div>
        </details>
      )}
      {suggestion.knowledge && suggestion.knowledge.length > 0 && (
        <details className="[&_summary]:cursor-pointer [&_summary]:text-xs [&_summary]:text-muted-foreground">
          <summary>
            Using {suggestion.knowledge.length} knowledge source{suggestion.knowledge.length === 1 ? '' : 's'} as context
          </summary>
          {suggestion.knowledge.map((k, i) => (
            <div
              key={i}
              className="mt-1.5 border-t border-border pt-1.5 first:mt-0 first:border-t-0 first:pt-1"
            >
              <b>{k.name}</b>
              {k.url ? <span className="ml-2 font-mono text-xs text-muted-foreground">{k.url}</span> : null}
              <p className="mt-0.5 text-xs text-muted-foreground">{k.excerpt}</p>
            </div>
          ))}
        </details>
      )}
      {suggestion.reason && <p className="my-2 text-sm text-muted-foreground">{suggestion.reason}</p>}
      <div className="mt-2 max-h-[300px] overflow-auto rounded-lg border bg-muted/40 px-3 py-2.5">
        {suggestion.text.split(/\n\s*\n/).map((p, i) =>
          p.startsWith('##') ? (
            <h3 key={i} className="my-1 text-sm font-semibold">
              {p.replace(/^#+\s*/, '')}
            </h3>
          ) : (
            <p key={i}>{p}</p>
          ),
        )}
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
