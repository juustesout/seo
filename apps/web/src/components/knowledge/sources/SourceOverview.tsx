/**
 * Source Detail "Overview" section (KBUI2).
 *
 * The identity facts a user needs to recognise a source: its type, the origin
 * (URL or original filename), its size where known, how many chunks are stored,
 * and its optional collection. Editors can reassign the collection here through
 * the existing KB8 PATCH; the select is the single collection control in the
 * drawer so there is no duplicate organizer. All values are stored metadata.
 */
import type { KnowledgeCollectionDto, KnowledgeSourceDetailDto } from '@seo/contracts';
import { fmtNum } from '@/lib/ui';
import { SourceField } from './SourceField';
import { SourceSection } from './SourceSection';
import { fileLabel, formatBytes, SOURCE_TYPE_LABELS } from '../format';

const selectClass = 'h-8 rounded-md border bg-background px-2 text-sm text-foreground';

export function SourceOverview({
  detail,
  canEdit,
  collections = [],
  collectionBusy,
  onCollectionChange,
}: {
  detail: KnowledgeSourceDetailDto;
  canEdit: boolean;
  collections?: KnowledgeCollectionDto[];
  collectionBusy: boolean;
  onCollectionChange: (collectionId: string | null) => void;
}) {
  const size = formatBytes(detail.size_bytes);

  return (
    <SourceSection title="Overview">
      <dl className="grid grid-cols-2 gap-3">
        <SourceField label="Type" value={SOURCE_TYPE_LABELS[detail.source_type]} />
        <SourceField label="Chunks" value={fmtNum(detail.chunk_count)} />

        {detail.source_type === 'url' && (
          <SourceField label="URL" value={<span className="break-all font-mono text-xs">{detail.url ?? '—'}</span>} />
        )}

        {detail.source_type === 'file' && (
          <>
            <SourceField label="Original filename" value={detail.original_filename ?? '—'} />
            <SourceField label="File type" value={fileLabel(detail.content_type, detail.original_filename)} />
            {size && <SourceField label="Size" value={size} />}
          </>
        )}
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Collection</span>
        {canEdit ? (
          <select
            aria-label="Collection"
            className={selectClass}
            value={detail.collection_id ?? ''}
            disabled={collectionBusy}
            onChange={(e) => onCollectionChange(e.target.value || null)}
          >
            <option value="">Uncategorized</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm">{detail.collection_name ?? 'Uncategorized'}</span>
        )}
      </div>
    </SourceSection>
  );
}
