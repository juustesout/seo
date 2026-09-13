/**
 * Presentation helpers shared by the Knowledge Library and the Content Studio
 * knowledge panel (KB5). Pure and side-effect free: they map stored metadata to
 * human labels only and never touch content bodies, so hostile text is never
 * interpreted here.
 */
import type {
  KnowledgeFreshnessState,
  KnowledgeRefreshPolicy,
  KnowledgeSourceDto,
  KnowledgeSourceStatus,
  KnowledgeSourceType,
} from '@seo/contracts';

/** Accepted upload types (kept in sync with the server allow-list). */
export const KNOWLEDGE_FILE_ACCEPT = '.txt,.md,.markdown,.pdf,.docx';

/** Human label for a file source, derived from its stored MIME/extension. */
export function fileLabel(contentType: string | null, filename: string | null): string {
  const type = (contentType ?? '').toLowerCase();
  if (type === 'application/pdf' || /\.pdf$/i.test(filename ?? '')) return 'PDF';
  if (type.includes('wordprocessingml') || /\.docx$/i.test(filename ?? '')) return 'DOCX';
  if (type === 'text/markdown' || type === 'text/x-markdown' || /\.markdown?$/i.test(filename ?? '')) return 'Markdown';
  if (type === 'text/plain') return 'Text';
  return (filename?.split('.').pop() ?? 'File').toUpperCase();
}

/** Compact byte size for the source list (e.g. "1.2 MB"). */
export function formatBytes(bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const SOURCE_TYPE_LABELS: Record<KnowledgeSourceType, string> = {
  text: 'Text',
  url: 'URL',
  file: 'File',
};

export const SOURCE_STATUS_LABELS: Record<KnowledgeSourceStatus, string> = {
  draft: 'Draft',
  queued: 'Queued',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
  deleted: 'Deleting',
};

/** Semantic badge variant for a source status (unknown values stay neutral). */
export function statusBadgeVariant(status: KnowledgeSourceStatus): 'success' | 'destructive' | 'warning' | 'outline' {
  if (status === 'ready') return 'success';
  if (status === 'failed') return 'destructive';
  if (status === 'queued' || status === 'processing' || status === 'deleted') return 'warning';
  return 'outline';
}

/** Short secondary metadata line for one source (type-specific). */
export function sourceMetaLine(source: {
  source_type: KnowledgeSourceType;
  url: string | null;
  original_filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
}): string {
  if (source.source_type === 'file') {
    return [fileLabel(source.content_type, source.original_filename), formatBytes(source.size_bytes)]
      .filter(Boolean)
      .join(' · ');
  }
  if (source.source_type === 'url') return source.url ?? '';
  return 'Text';
}

/** Human label for a derived freshness state (KB7). */
export const FRESHNESS_LABELS: Record<KnowledgeFreshnessState, string> = {
  fresh: 'Fresh',
  due: 'Due',
  stale: 'Stale',
  unknown: 'Unknown',
};

/** Neutral/semantic badge variant for a freshness state. */
export function freshnessBadgeVariant(
  state: KnowledgeFreshnessState,
): 'success' | 'warning' | 'destructive' | 'outline' {
  if (state === 'fresh') return 'success';
  if (state === 'due') return 'warning';
  if (state === 'stale') return 'destructive';
  return 'outline';
}

/** Human label for a refresh cadence. */
export const REFRESH_POLICY_LABELS: Record<KnowledgeRefreshPolicy, string> = {
  manual: 'Manual',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

/**
 * Derive one "recent activity" line for a source from stored timestamps only -
 * there is no event log. The latest of a successful refresh and a (re)index
 * wins; a never-processed source falls back to Added/Updated. Honest by design:
 * it can only ever describe timestamps the API actually recorded.
 */
export function sourceActivity(
  source: Pick<KnowledgeSourceDto, 'freshness' | 'last_indexed_at' | 'created_at' | 'updated_at'>,
): { label: 'Refreshed' | 'Processed' | 'Added' | 'Updated'; at: string } {
  const fetched = source.freshness?.last_fetched_at ?? null;
  const indexed = source.last_indexed_at;
  if (fetched && (!indexed || Date.parse(fetched) > Date.parse(indexed))) {
    return { label: 'Refreshed', at: fetched };
  }
  if (indexed) return { label: 'Processed', at: indexed };
  if (source.created_at && source.created_at === source.updated_at) return { label: 'Added', at: source.created_at };
  return { label: 'Updated', at: source.updated_at };
}

/** Compact relative time for the activity feed (falls back to a date). */
export function fmtRelative(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diff = now.getTime() - then;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const d = new Date(then);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
