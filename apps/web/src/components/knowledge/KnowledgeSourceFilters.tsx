/**
 * Knowledge Library filter bar (KB5).
 *
 * Type/status are chosen from the shared canonical vocabularies and sort is a
 * fixed allowlist - the UI never offers a value the API would reject. Search is
 * metadata-only (name/url/filename); the owning library debounces it before it
 * reaches the API.
 */
import {
  KNOWLEDGE_SOURCE_SORTS,
  KNOWLEDGE_SOURCE_STATUSES,
  KNOWLEDGE_SOURCE_TYPES,
  type KnowledgeSourceSort,
  type KnowledgeSourceStatus,
  type KnowledgeSourceSummaryDto,
  type KnowledgeSourceType,
} from '@seo/contracts';
import { Input } from '@/components/ui/input';
import { SOURCE_STATUS_LABELS, SOURCE_TYPE_LABELS } from './format';

export interface KnowledgeFilterState {
  type: KnowledgeSourceType | '';
  status: KnowledgeSourceStatus | '';
  search: string;
  sort: KnowledgeSourceSort;
}

const SORT_LABELS: Record<KnowledgeSourceSort, string> = {
  updated_desc: 'Newest',
  updated_asc: 'Oldest',
  indexed_desc: 'Recently indexed',
  indexed_asc: 'Oldest indexed',
  name_asc: 'Name A-Z',
  name_desc: 'Name Z-A',
};

const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm text-foreground';

function SummaryChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
      <b className="text-foreground tabular-nums">{value.toLocaleString()}</b>
      {label}
    </span>
  );
}

export function KnowledgeSourceFilters({
  value,
  onChange,
  summary,
  total,
}: {
  value: KnowledgeFilterState;
  onChange: (patch: Partial<KnowledgeFilterState>) => void;
  summary: KnowledgeSourceSummaryDto | null;
  total: number;
}) {
  return (
    <div className="grid gap-3">
      {summary && (
        <div className="flex flex-wrap gap-1.5" aria-label="Knowledge summary">
          <SummaryChip label={total === 1 ? 'source' : 'sources'} value={summary.total} />
          <SummaryChip label="ready" value={summary.ready} />
          <SummaryChip label="processing" value={summary.processing} />
          <SummaryChip label="failed" value={summary.failed} />
          <SummaryChip label="chunks" value={summary.total_chunks} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label="Search sources"
          placeholder="Search name, URL or filename…"
          value={value.search}
          onChange={(e) => onChange({ search: e.target.value })}
          className="min-w-[180px] flex-1"
        />
        <select
          aria-label="Filter by type"
          className={selectClass}
          value={value.type}
          onChange={(e) => onChange({ type: e.target.value as KnowledgeFilterState['type'] })}
        >
          <option value="">All types</option>
          {KNOWLEDGE_SOURCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {SOURCE_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          className={selectClass}
          value={value.status}
          onChange={(e) => onChange({ status: e.target.value as KnowledgeFilterState['status'] })}
        >
          <option value="">Active (no deleted)</option>
          {KNOWLEDGE_SOURCE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort sources"
          className={selectClass}
          value={value.sort}
          onChange={(e) => onChange({ sort: e.target.value as KnowledgeSourceSort })}
        >
          {KNOWLEDGE_SOURCE_SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
