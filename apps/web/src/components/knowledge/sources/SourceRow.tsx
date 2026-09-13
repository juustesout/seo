/**
 * One source row in the Sources list (KBUI2).
 *
 * A compact, scannable row: name, type/status/freshness/collection badges and a
 * type-specific metadata line. It is navigational (opening the Source Detail
 * drawer); lifecycle actions live in the detail so rows stay quiet. Metadata is
 * rendered as plain text - names and URLs are untrusted.
 */
import type { KnowledgeSourceDto } from '@seo/contracts';
import { Badge } from '@/components/ui/badge';
import { fmtDate, fmtNum } from '@/lib/ui';
import {
  FRESHNESS_LABELS,
  freshnessBadgeVariant,
  SOURCE_STATUS_LABELS,
  SOURCE_TYPE_LABELS,
  sourceMetaLine,
  statusBadgeVariant,
} from '../format';

export function SourceRow({
  source,
  selected,
  selectable,
  checked,
  onToggleSelect,
  onSelect,
}: {
  source: KnowledgeSourceDto;
  selected: boolean;
  selectable: boolean;
  checked: boolean;
  onToggleSelect: (id: string) => void;
  onSelect: (source: KnowledgeSourceDto) => void;
}) {
  const meta = sourceMetaLine(source);

  return (
    <li
      data-selected={selected || undefined}
      className={`rounded-lg border px-3 py-2.5 ${selected ? 'border-primary/50 bg-muted/60' : 'bg-muted/30'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {selectable && (
            <input
              type="checkbox"
              aria-label={`Select ${source.name}`}
              checked={checked}
              onChange={() => onToggleSelect(source.id)}
            />
          )}
          <button
            type="button"
            className="truncate text-left text-[13px] font-semibold hover:underline"
            onClick={() => onSelect(source)}
          >
            {source.name}
          </button>
          {source.collection_name && <Badge variant="outline">{source.collection_name}</Badge>}
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline">{SOURCE_TYPE_LABELS[source.source_type]}</Badge>
          <Badge variant={statusBadgeVariant(source.status)}>{SOURCE_STATUS_LABELS[source.status]}</Badge>
          {source.source_type === 'url' && source.freshness && (
            <Badge variant={freshnessBadgeVariant(source.freshness.state)}>{FRESHNESS_LABELS[source.freshness.state]}</Badge>
          )}
        </div>
      </div>

      {meta && <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{meta}</div>}

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Updated {fmtDate(source.updated_at)}</span>
        <span>
          {fmtNum(source.chunk_count)} chunk{source.chunk_count === 1 ? '' : 's'}
        </span>
      </div>
    </li>
  );
}
