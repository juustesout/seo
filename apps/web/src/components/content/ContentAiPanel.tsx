import type { ContentAiSuggestionDto } from '@seo/contracts';
import { AI_ACTION_LABELS } from './contentAi';

interface ContentAiPanelProps {
  suggestion: ContentAiSuggestionDto;
  onApply: () => void;
  onReject: () => void;
}

/** Review-before-apply panel for an AI suggestion. Never auto-applies. */
export function ContentAiPanel({ suggestion, onApply, onReject }: ContentAiPanelProps) {
  return (
    <div className="ai-panel">
      <div className="ai-panel-head">
        <strong>AI suggestion — {AI_ACTION_LABELS[suggestion.action]}</strong>
        <span className="muted mono" style={{ fontSize: 12 }}>
          {suggestion.model}
        </span>
      </div>
      {suggestion.source && (
        <details className="ai-source">
          <summary>Original selection</summary>
          <div className="ai-block">{suggestion.source}</div>
        </details>
      )}
      {suggestion.knowledge && suggestion.knowledge.length > 0 && (
        <details className="ai-source">
          <summary>
            Using {suggestion.knowledge.length} knowledge source{suggestion.knowledge.length === 1 ? '' : 's'} as context
          </summary>
          {suggestion.knowledge.map((k, i) => (
            <div key={i} className="ai-knowledge-row">
              <b>{k.name}</b>
              {k.url ? (
                <span className="mono muted" style={{ fontSize: 12 }}>
                  {k.url}
                </span>
              ) : null}
              <p className="sub">{k.excerpt}</p>
            </div>
          ))}
        </details>
      )}
      {suggestion.reason && <p className="sub" style={{ margin: '8px 0' }}>{suggestion.reason}</p>}
      <div className="ai-block">
        {suggestion.text.split(/\n\s*\n/).map((p, i) =>
          p.startsWith('##') ? (
            <h3 key={i} className="ai-heading">
              {p.replace(/^#+\s*/, '')}
            </h3>
          ) : (
            <p key={i}>{p}</p>
          ),
        )}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary sm" onClick={onApply}>
          Apply
        </button>
        <button className="btn sm" onClick={onReject}>
          Reject
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          AI never edits your document automatically — review before you apply. Undo stays available afterwards.
        </span>
      </div>
    </div>
  );
}
