/**
 * Knowledge Overview - Recent activity (KBUI3).
 *
 * A short, honest feed built from the timestamps the registry already stores
 * (last refresh, last index, created/updated); there is no event log. Each row
 * deep-links to the source so the user can act on it.
 */
import type { KnowledgeSourceDto } from '@seo/contracts';
import { Badge } from '@/components/ui/badge';
import { Empty } from '@/lib/ui';
import { fmtRelative, SOURCE_STATUS_LABELS, sourceActivity, statusBadgeVariant } from '../format';

export function RecentActivity({
  items,
  onOpenSource,
}: {
  items: KnowledgeSourceDto[];
  onOpenSource: (id: string) => void;
}) {
  return (
    <section className="grid gap-2 rounded-lg border bg-card p-4" aria-label="Recent activity">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recent activity</h3>
      {items.length === 0 ? (
        <Empty>No activity yet.</Empty>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {items.map((s) => {
            const activity = sourceActivity(s);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpenSource(s.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted/40"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{s.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {activity.label} {fmtRelative(activity.at)}
                    </span>
                  </span>
                  <Badge variant={statusBadgeVariant(s.status)}>{SOURCE_STATUS_LABELS[s.status]}</Badge>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
