/**
 * Knowledge source list (KBUI2).
 *
 * Renders bounded source metadata only - never a content body or a storage key.
 * Each row is navigational and opens the Source Detail drawer; bulk selection is
 * available to editors via a checkbox. The list owns no lifecycle requests.
 */
import type { KnowledgeSourceDto } from '@seo/contracts';
import { Empty } from '@/lib/ui';
import { SourceRow } from './SourceRow';

export function SourceList({
  items,
  selectedId,
  selectable = false,
  selectedIds = [],
  onToggleSelect,
  onSelect,
}: {
  items: KnowledgeSourceDto[];
  selectedId: string | null;
  selectable?: boolean;
  selectedIds?: string[];
  onToggleSelect?: (id: string) => void;
  onSelect: (source: KnowledgeSourceDto) => void;
}) {
  if (items.length === 0) {
    return <Empty>No sources match these filters.</Empty>;
  }

  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {items.map((source) => (
        <SourceRow
          key={source.id}
          source={source}
          selected={source.id === selectedId}
          selectable={selectable}
          checked={selectedIds.includes(source.id)}
          onToggleSelect={onToggleSelect ?? (() => {})}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
