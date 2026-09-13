/**
 * Knowledge Overview - Active processing (KBUI3).
 *
 * Shows that background work is happening using the real lifecycle only: the
 * count from the summary and the names of sources currently queued/processing.
 * No progress bars or percentages are invented - the API exposes neither.
 */
import type { KnowledgeSourceDto } from '@seo/contracts';
import { Button } from '@/components/ui/button';

export function ProcessingSummary({
  count,
  items,
  onView,
}: {
  count: number;
  items: KnowledgeSourceDto[];
  onView: () => void;
}) {
  if (count === 0) return null;
  const shown = items.slice(0, 4);
  return (
    <section className="grid gap-2 rounded-lg border bg-card p-4" aria-label="Active processing">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Processing</h3>
        <Button size="sm" variant="outline" onClick={onView}>
          View processing
        </Button>
      </div>
      <p className="text-sm">
        {count} source{count === 1 ? '' : 's'} currently processing
      </p>
      {shown.length > 0 && (
        <ul className="m-0 grid list-none gap-1 p-0">
          {shown.map((s) => (
            <li key={s.id} className="truncate text-xs text-muted-foreground">
              {s.name}
            </li>
          ))}
          {count > shown.length && <li className="text-xs text-muted-foreground">…and {count - shown.length} more</li>}
        </ul>
      )}
    </section>
  );
}
