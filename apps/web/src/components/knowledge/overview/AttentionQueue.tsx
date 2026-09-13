/**
 * Knowledge Overview - Needs attention (KBUI3).
 *
 * Only sources where a human action is genuinely useful: failed (with the safe
 * error sentence) and URL sources that are due or stale. Processing is normal
 * work and lives in ProcessingSummary instead - it is never framed as a problem.
 * Every row deep-links to the source, each category to the matching filter.
 */
import { knowledgeErrorMessage, type KnowledgeSourceDto } from '@seo/contracts';
import { Button } from '@/components/ui/button';
import { fmtRelative } from '../format';

export function AttentionQueue({
  failed,
  due,
  stale,
  onOpenSource,
  onReview,
}: {
  failed: KnowledgeSourceDto[];
  due: KnowledgeSourceDto[];
  stale: KnowledgeSourceDto[];
  onOpenSource: (id: string) => void;
  onReview: (params: Record<string, string>) => void;
}) {
  const refresh = [...stale, ...due];
  const total = failed.length + refresh.length;

  return (
    <section className="grid gap-2 rounded-lg border bg-card p-4" aria-label="Needs attention">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Needs attention</h3>
        <span className="text-xs text-muted-foreground">{total} source{total === 1 ? '' : 's'}</span>
      </div>

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing needs attention.</p>
      ) : (
        <div className="grid gap-3">
          {failed.length > 0 && (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-destructive">Source failed</span>
                <Button size="sm" variant="outline" onClick={() => onReview({ status: 'failed' })}>
                  Review
                </Button>
              </div>
              {failed.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onOpenSource(s.id)}
                  className="rounded-md border bg-background px-2.5 py-2 text-left transition-colors hover:border-primary/40"
                >
                  <span className="block truncate text-sm">{s.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {s.error ? knowledgeErrorMessage(s.error) : 'Could not be processed. Open to inspect.'}
                  </span>
                </button>
              ))}
            </div>
          )}

          {refresh.length > 0 && (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-warning">Sources need refreshing</span>
                <Button size="sm" variant="outline" onClick={() => onReview({ freshness: stale.length > 0 ? 'stale' : 'due' })}>
                  Review
                </Button>
              </div>
              {refresh.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onOpenSource(s.id)}
                  className="rounded-md border bg-background px-2.5 py-2 text-left transition-colors hover:border-primary/40"
                >
                  <span className="block truncate text-sm">{s.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {s.freshness?.state === 'stale' ? 'Overdue' : 'Due'}
                    {s.freshness?.last_fetched_at ? ` · last checked ${fmtRelative(s.freshness.last_fetched_at)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
