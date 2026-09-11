/**
 * Content Intelligence panel (Phase G). Renders deterministic, read-only
 * signals (SEO / GSC / DataForSEO / Knowledge) for a saved document plus an
 * optional, explicitly requested AI assistant pass - the AI is never run
 * automatically. Sources that are not configured are labeled "off" rather than
 * hidden, so the panel explains why certain recommendations cannot exist.
 */
import { useState } from 'react';
import type {
  ContentIntelligenceReport,
  ContentIntelligenceSource,
  ContentRecommendation,
} from '@seo/contracts';
import { api } from '../../lib/api';
import { useAsync, Empty } from '../../lib/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const PRIORITY_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const TYPE_LABEL: Record<string, string> = { issue: 'Issue', opportunity: 'Opportunity', insight: 'Insight' };

function sourcePill(source: ContentIntelligenceSource) {
  return (
    <Badge
      key={source.id}
      variant={source.state === 'configured' ? 'success' : source.state === 'not_configured' ? 'destructive' : 'outline'}
      title={source.note ?? undefined}
    >
      {source.label}
      {source.state === 'not_configured' ? ' · off' : source.state === 'no_data' ? ' · no data' : ''}
    </Badge>
  );
}

/** One recommendation card: type/priority/source header, evidence links, suggested action, optional session dismiss. */
function RecommendationCard({ rec, onDismiss }: { rec: ContentRecommendation; onDismiss: (id: string) => void }) {
  return (
    <div
      className={cn(
        'rounded-lg border border-l-[3px] bg-muted/40 px-2.5 py-2',
        rec.priority === 'high' ? 'border-l-destructive' : rec.priority === 'medium' ? 'border-l-warning' : 'border-l-success',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{TYPE_LABEL[rec.type] ?? rec.type}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{PRIORITY_LABEL[rec.priority] ?? rec.priority}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{rec.source}</span>
        {rec.dismissible && (
          <button
            className="ml-auto cursor-pointer border-none bg-transparent px-0.5 text-[15px] leading-none text-muted-foreground hover:text-destructive"
            title="Dismiss for this session"
            onClick={() => onDismiss(rec.id)}
          >
            ×
          </button>
        )}
      </div>
      <div className="my-1 text-[12.5px] font-semibold">{rec.title}</div>
      <p className="m-0 mb-1.5 text-[11.5px] leading-snug text-muted-foreground">{rec.description}</p>
      {rec.evidence && rec.evidence.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {rec.evidence.map((e, i) => (
            <span key={i} className="rounded-[5px] border bg-card px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
              <span className="mr-1 opacity-75">{e.label}</span>
              {e.url ? (
                <a className="text-success underline" href={e.url} target="_blank" rel="noreferrer">
                  {e.value}
                </a>
              ) : (
                e.value
              )}
            </span>
          ))}
        </div>
      )}
      {rec.action?.text && <div className="text-[11.5px] leading-snug">→ {rec.action.text}</div>}
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
    <div className="flex flex-col gap-2 rounded-[10px] border bg-card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Intelligence</h3>
        <span className="text-[11px] text-muted-foreground">Signals from your project data</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button variant="outline" size="sm" onClick={state.reload} disabled={state.loading}>
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={state.loading || Boolean(state.data?.ai.requested && state.data?.ai.available)}
          onClick={() => setWithAi(true)}
          title="Requests the optional AI assistant (a generated suggestion you review before acting)"
        >
          {withAi ? 'AI…' : 'Ask AI'}
        </Button>
        {withAi && (
          <Button variant="outline" size="sm" onClick={() => setWithAi(false)}>
            Clear AI
          </Button>
        )}
      </div>

      {state.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {state.error}
        </div>
      )}
      {!state.error && state.loading && state.data === null && (
        <p className="text-xs text-muted-foreground">Gathering signals…</p>
      )}

      {state.data && (
        <>
          {sources.length > 0 && <div className="my-0.5 flex flex-wrap gap-1">{sources.map(sourcePill)}</div>}

          {state.data.ai.requested && state.data.ai.note && (
            <p
              className={cn(
                'm-0 rounded-md border border-dashed px-2 py-1.5 text-[11.5px] text-muted-foreground',
                !state.data.ai.available && 'border-destructive/40 text-destructive',
              )}
            >
              {state.data.ai.note}
            </p>
          )}

          {recs.length > 0 ? (
            <div className="flex max-h-[48vh] flex-col gap-2 overflow-y-auto">
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
