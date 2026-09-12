/**
 * Knowledge source list (KB5).
 *
 * Renders bounded source metadata only - never a content body or a storage key.
 * The name opens the detail surface; lifecycle actions are rendered per row by
 * `KnowledgeSourceActions` and the library owns the requests.
 */
import { knowledgeErrorMessage, type KnowledgeSourceDto } from '@seo/contracts';
import { Badge } from '@/components/ui/badge';
import { Empty, fmtDate, fmtNum } from '@/lib/ui';
import { KnowledgeSourceActions } from './KnowledgeSourceActions';
import { SOURCE_TYPE_LABELS, sourceMetaLine, statusBadgeVariant, SOURCE_STATUS_LABELS } from './format';

export function KnowledgeSourceList({
  items,
  selectedId,
  canEdit,
  busyId,
  selectable = false,
  selectedIds = [],
  onToggleSelect,
  onSelect,
  onIngest,
  onReindex,
  onDelete,
}: {
  items: KnowledgeSourceDto[];
  selectedId: string | null;
  canEdit: boolean;
  busyId: string | null;
  selectable?: boolean;
  selectedIds?: string[];
  onToggleSelect?: (id: string) => void;
  onSelect: (source: KnowledgeSourceDto) => void;
  onIngest: (id: string) => void;
  onReindex: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (items.length === 0) {
    return <Empty>No sources match these filters.</Empty>;
  }

  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {items.map((source) => {
        const meta = sourceMetaLine(source);
        const selected = source.id === selectedId;
        return (
          <li
            key={source.id}
            data-selected={selected || undefined}
            className={`rounded-lg border px-3 py-2.5 ${selected ? 'border-primary/50 bg-muted/60' : 'bg-muted/30'}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {selectable && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${source.name}`}
                    checked={selectedIds.includes(source.id)}
                    onChange={() => onToggleSelect?.(source.id)}
                  />
                )}
                <button
                  type="button"
                  className="text-left text-[13px] font-semibold hover:underline"
                  onClick={() => onSelect(source)}
                >
                  {source.name}
                </button>
                {source.collection_name && <Badge variant="outline">{source.collection_name}</Badge>}
              </div>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline">{SOURCE_TYPE_LABELS[source.source_type]}</Badge>
                <Badge variant={statusBadgeVariant(source.status)}>{SOURCE_STATUS_LABELS[source.status]}</Badge>
              </div>
            </div>

            {meta && <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{meta}</div>}

            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Created {fmtDate(source.created_at)}</span>
              <span>Last indexed {source.last_indexed_at ? fmtDate(source.last_indexed_at) : '—'}</span>
              <span>
                {fmtNum(source.chunk_count)} chunk{source.chunk_count === 1 ? '' : 's'}
              </span>
            </div>

            {source.error && (
              <div className="mt-1 text-xs text-destructive">{knowledgeErrorMessage(source.error)}</div>
            )}

            <div className="mt-2">
              <KnowledgeSourceActions
                source={source}
                canEdit={canEdit}
                busy={busyId === source.id}
                onIngest={onIngest}
                onReindex={onReindex}
                onDelete={onDelete}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
