import { useState } from 'react';
import type {
  ContentIntelligenceReport,
  ContentIntelligenceSource,
  ContentRecommendation,
} from '@seo/contracts';
import { api } from '../../lib/api';
import { useAsync, Empty } from '../../lib/ui';

const PRIORITY_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const TYPE_LABEL: Record<string, string> = { issue: 'Issue', opportunity: 'Opportunity', insight: 'Insight' };

function sourcePill(source: ContentIntelligenceSource) {
  const cls = source.state === 'configured' ? 'ok' : source.state === 'not_configured' ? 'err' : '';
  return (
    <span key={source.id} className={`pill intel-src-pill ${cls}`} title={source.note ?? undefined}>
      {source.label}
      {source.state === 'not_configured' ? ' · off' : source.state === 'no_data' ? ' · no data' : ''}
    </span>
  );
}

function RecommendationCard({ rec, onDismiss }: { rec: ContentRecommendation; onDismiss: (id: string) => void }) {
  return (
    <div className={`intel-rec intel-rec-${rec.priority}`}>
      <div className="intel-rec-top">
        <span className="intel-rec-type">{TYPE_LABEL[rec.type] ?? rec.type}</span>
        <span className="intel-rec-priority">{PRIORITY_LABEL[rec.priority] ?? rec.priority}</span>
        <span className="intel-rec-source mono">{rec.source}</span>
        {rec.dismissible && (
          <button className="intel-dismiss" title="Dismiss for this session" onClick={() => onDismiss(rec.id)}>
            ×
          </button>
        )}
      </div>
      <div className="intel-rec-title">{rec.title}</div>
      <p className="intel-rec-desc">{rec.description}</p>
      {rec.evidence && rec.evidence.length > 0 && (
        <div className="intel-evidence">
          {rec.evidence.map((e, i) => (
            <span className="intel-ev" key={i}>
              <span className="intel-ev-label">{e.label}</span>
              {e.url ? (
                <a href={e.url} target="_blank" rel="noreferrer">
                  {e.value}
                </a>
              ) : (
                e.value
              )}
            </span>
          ))}
        </div>
      )}
      {rec.action?.text && <div className="intel-rec-action">→ {rec.action.text}</div>}
    </div>
  );
}

/**
 * Content Intelligence panel (Phase G). Read-only deterministic signals
 * (SEO/GSC/DataForSEO/Knowledge) for the saved document, with an optional
 * explicit AI assistant pass that never runs automatically.
 */
export function IntelligencePanel({ projectId, contentId }: { projectId: string; contentId: string }) {
  const [withAi, setWithAi] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const state = useAsync<ContentIntelligenceReport>(
    () =>
      api(`/projects/${projectId}/content/${contentId}/intelligence${withAi ? '?with_ai=1' : ''}`),
    [projectId, contentId, withAi],
  );

  const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id));
  const recs = (state.data?.recommendations ?? []).filter((r) => !dismissed.has(r.id));
  const sources = state.data?.sources ?? [];

  return (
    <div className="intel-panel">
      <div className="intel-head">
        <h3>Intelligence</h3>
        <span className="muted intel-note">Signals from your project data</span>
      </div>

      <div className="intel-actions">
        <button className="btn sm" onClick={state.reload} disabled={state.loading}>
          Refresh
        </button>
        <button
          className="btn sm"
          disabled={state.loading || Boolean(state.data?.ai.requested && state.data?.ai.available)}
          onClick={() => setWithAi(true)}
          title="Requests the optional AI assistant (a generated suggestion you review before acting)"
        >
          {withAi ? 'AI…' : 'Ask AI'}
        </button>
        {withAi && (
          <button className="btn sm" onClick={() => setWithAi(false)}>
            Clear AI
          </button>
        )}
      </div>

      {state.error && <div className="banner error">{state.error}</div>}
      {!state.error && state.loading && state.data === null && (
        <p className="muted" style={{ fontSize: 12 }}>
          Gathering signals…
        </p>
      )}

      {state.data && (
        <>
          {sources.length > 0 && <div className="intel-sources">{sources.map(sourcePill)}</div>}

          {state.data.ai.requested && state.data.ai.note && (
            <p className={`intel-ai-note ${state.data.ai.available ? '' : 'err'}`}>{state.data.ai.note}</p>
          )}

          {recs.length > 0 ? (
            <div className="intel-list">
              {recs.map((rec) => (
                <RecommendationCard key={rec.id} rec={rec} onDismiss={dismiss} />
              ))}
            </div>
          ) : (
            !state.loading && (
              <Empty>
                No recommendation right now.
                {sources.some((s) => s.state === 'not_configured') ? ' Connect the available sources to unlock signals.' : ''}
              </Empty>
            )
          )}
        </>
      )}
    </div>
  );
}
