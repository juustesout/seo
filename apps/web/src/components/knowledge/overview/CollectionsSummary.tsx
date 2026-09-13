/**
 * Knowledge Overview - Collections & summary (KBUI3).
 *
 * A compact read of how the knowledge base is organized: each collection's
 * stored source count plus the uncategorized remainder, deep-linking into the
 * filtered Sources view. It is a summary only - managing collections stays in
 * the existing KB8 controls on the Sources page, never duplicated here.
 */
import type { KnowledgeCollectionDto } from '@seo/contracts';
import { Button } from '@/components/ui/button';

export function CollectionsSummary({
  collections,
  totalSources,
  onOpenCollection,
  onOpenUncategorized,
  onManage,
}: {
  collections: KnowledgeCollectionDto[];
  totalSources: number;
  onOpenCollection: (id: string) => void;
  onOpenUncategorized: () => void;
  onManage: () => void;
}) {
  const ranked = [...collections].sort((a, b) => b.sourceCount - a.sourceCount || a.name.localeCompare(b.name));
  const shown = ranked.slice(0, 6);
  const assigned = collections.reduce((n, c) => n + c.sourceCount, 0);
  const uncategorized = Math.max(0, totalSources - assigned);

  return (
    <section className="grid gap-2 rounded-lg border bg-card p-4" aria-label="Collections summary">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Collections</h3>
        <Button size="sm" variant="outline" onClick={onManage}>
          Manage collections
        </Button>
      </div>

      {collections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Organize sources into collections when your knowledge base grows.
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {shown.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onOpenCollection(c.id)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted/40"
              >
                <span className="truncate text-sm">{c.name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {c.sourceCount} source{c.sourceCount === 1 ? '' : 's'}
                </span>
              </button>
            </li>
          ))}
          {uncategorized > 0 && (
            <li>
              <button
                type="button"
                onClick={onOpenUncategorized}
                className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted/40"
              >
                <span className="truncate text-sm text-muted-foreground">Uncategorized</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {uncategorized} source{uncategorized === 1 ? '' : 's'}
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
