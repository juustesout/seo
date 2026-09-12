/**
 * Knowledge source detail drawer (KB5, extended in KB7).
 *
 * A read-only, safe surface for one source: identity, timestamps, chunk count,
 * type-specific metadata, the safe error sentence and a bounded plain-text
 * preview. It is not a document viewer - no PDF/DOCX/Markdown/HTML rendering -
 * and content is always treated as text.
 *
 * For URL sources it also shows the derived freshness facts and, for editors,
 * offers an explicit Refresh now plus a refresh-policy selector. The detail
 * polls its own source after a refresh so it can report the honest outcome
 * (updated/reindexed, unchanged, or failed with existing content preserved)
 * without inventing a result.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KNOWLEDGE_REFRESH_POLICIES,
  knowledgeErrorMessage,
  type KnowledgeCollectionDto,
  type KnowledgeRefreshPolicy,
  type KnowledgeSourceDetailDto,
} from '@seo/contracts';
import { api } from '../../lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fmtDate, fmtNum } from '@/lib/ui';
import { KnowledgeSourceActions } from './KnowledgeSourceActions';
import {
  fileLabel,
  formatBytes,
  FRESHNESS_LABELS,
  freshnessBadgeVariant,
  REFRESH_POLICY_LABELS,
  SOURCE_STATUS_LABELS,
  SOURCE_TYPE_LABELS,
  statusBadgeVariant,
} from './format';

const REFRESH_POLL_MS = 400;
const REFRESH_POLL_ATTEMPTS = 75;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

export function KnowledgeSourceDetail({
  projectId,
  detail,
  loading,
  error,
  canEdit,
  busy,
  collections = [],
  onClose,
  onIngest,
  onReindex,
  onDelete,
  onChanged,
}: {
  projectId: string;
  detail: KnowledgeSourceDetailDto | null;
  loading: boolean;
  error: string | null;
  canEdit: boolean;
  busy: boolean;
  collections?: KnowledgeCollectionDto[];
  onClose: () => void;
  onIngest: (id: string) => void;
  onReindex: (id: string) => void;
  onDelete: (id: string) => void;
  onChanged?: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reset per-source transient state when a different source is opened.
  useEffect(() => {
    setActionError(null);
    setRefreshNotice(null);
    setRefreshing(false);
    setPolicyBusy(false);
    setCollectionBusy(false);
  }, [detail?.id]);

  const refreshNow = useCallback(async () => {
    if (!detail) return;
    setRefreshing(true);
    setActionError(null);
    setRefreshNotice(null);
    const previousChanged = detail.freshness?.last_changed_at ?? null;
    try {
      await api(`/projects/${projectId}/knowledge/sources/${detail.id}/refresh`, { method: 'POST', body: {} });
      setRefreshNotice('Refreshing…');
      for (let attempt = 0; attempt < REFRESH_POLL_ATTEMPTS; attempt += 1) {
        await sleep(REFRESH_POLL_MS);
        if (!mounted.current) return;
        const next = await api<KnowledgeSourceDetailDto>(`/projects/${projectId}/knowledge/sources/${detail.id}`);
        if (next.status === 'queued' || next.status === 'processing') continue;
        if (!mounted.current) return;
        if (next.error && (next.freshness?.refresh_failures ?? 0) > 0) {
          setRefreshNotice('Refresh failed. Existing indexed content is still available.');
        } else if ((next.freshness?.last_changed_at ?? null) !== previousChanged) {
          setRefreshNotice('Updated and reindexed.');
        } else {
          setRefreshNotice('Checked successfully. No content changes.');
        }
        onChanged?.();
        return;
      }
      setRefreshNotice('Still refreshing. Check back shortly.');
    } catch (e) {
      setActionError(message(e));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [detail, projectId, onChanged]);

  const changePolicy = useCallback(
    async (policy: KnowledgeRefreshPolicy) => {
      if (!detail) return;
      setPolicyBusy(true);
      setActionError(null);
      try {
        await api(`/projects/${projectId}/knowledge/sources/${detail.id}`, {
          method: 'PATCH',
          body: { refresh_policy: policy },
        });
        onChanged?.();
      } catch (e) {
        setActionError(message(e));
      } finally {
        if (mounted.current) setPolicyBusy(false);
      }
    },
    [detail, projectId, onChanged],
  );

  const changeCollection = useCallback(
    async (collectionId: string | null) => {
      if (!detail) return;
      setCollectionBusy(true);
      setActionError(null);
      try {
        await api(`/projects/${projectId}/knowledge/sources/${detail.id}`, {
          method: 'PATCH',
          body: { collection_id: collectionId },
        });
        onChanged?.();
      } catch (e) {
        setActionError(message(e));
      } finally {
        if (mounted.current) setCollectionBusy(false);
      }
    },
    [detail, projectId, onChanged],
  );

  const displayError = actionError ?? error;
  const freshness = detail?.freshness;
  const isUrl = detail?.source_type === 'url';
  const showRefreshFailure = Boolean(detail?.error && (freshness?.refresh_failures ?? 0) > 0 && detail?.status === 'ready');

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose} role="presentation">
      <aside
        role="dialog"
        aria-label="Source detail"
        className="h-full w-full max-w-lg overflow-y-auto border-l bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{detail?.name ?? 'Source detail'}</h2>
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {displayError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {displayError}
          </div>
        )}

        {detail && (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{SOURCE_TYPE_LABELS[detail.source_type]}</Badge>
              <Badge variant={statusBadgeVariant(detail.status)}>{SOURCE_STATUS_LABELS[detail.status]}</Badge>
              {isUrl && freshness && (
                <Badge variant={freshnessBadgeVariant(freshness.state)}>{FRESHNESS_LABELS[freshness.state]}</Badge>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-3">
              <Field label="Created" value={fmtDate(detail.created_at)} />
              <Field label="Updated" value={fmtDate(detail.updated_at)} />
              <Field label="Last indexed" value={detail.last_indexed_at ? fmtDate(detail.last_indexed_at) : '—'} />
              <Field label="Chunks" value={fmtNum(detail.chunk_count)} />

              {detail.source_type === 'text' && (
                <Field label="Characters" value={fmtNum(detail.preview?.characters ?? 0)} />
              )}
              {detail.source_type === 'url' && <Field label="Original URL" value={detail.url ?? '—'} />}
              {detail.source_type === 'file' && (
                <>
                  <Field label="Original filename" value={detail.original_filename ?? '—'} />
                  <Field label="File type" value={fileLabel(detail.content_type, detail.original_filename)} />
                  <Field label="Size" value={formatBytes(detail.size_bytes) ?? '—'} />
                </>
              )}
            </dl>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Collection</span>
              {canEdit ? (
                <select
                  aria-label="Collection"
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={detail.collection_id ?? ''}
                  disabled={collectionBusy}
                  onChange={(e) => void changeCollection(e.target.value || null)}
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

            {isUrl && freshness && (
              <div className="grid gap-2 rounded-lg border bg-muted/20 p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Freshness</div>
                <dl className="grid grid-cols-2 gap-3">
                  <Field label="Last fetched" value={freshness.last_fetched_at ? fmtDate(freshness.last_fetched_at) : '—'} />
                  <Field label="Last changed" value={freshness.last_changed_at ? fmtDate(freshness.last_changed_at) : '—'} />
                  <Field label="Next check" value={freshness.next_refresh_at ? fmtDate(freshness.next_refresh_at) : 'Not scheduled'} />
                  <Field
                    label="Refresh policy"
                    value={freshness.refresh_policy ? REFRESH_POLICY_LABELS[freshness.refresh_policy] : '—'}
                  />
                  {freshness.refresh_failures > 0 && (
                    <Field label="Refresh failures" value={fmtNum(freshness.refresh_failures)} />
                  )}
                </dl>

                {canEdit && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" disabled={refreshing || busy} onClick={() => void refreshNow()}>
                      {refreshing ? 'Refreshing…' : 'Refresh now'}
                    </Button>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      Policy
                      <select
                        aria-label="Refresh policy"
                        className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                        value={freshness.refresh_policy ?? 'manual'}
                        disabled={policyBusy}
                        onChange={(e) => void changePolicy(e.target.value as KnowledgeRefreshPolicy)}
                      >
                        {KNOWLEDGE_REFRESH_POLICIES.map((p) => (
                          <option key={p} value={p}>
                            {REFRESH_POLICY_LABELS[p]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                {refreshNotice && <p className="text-xs text-muted-foreground">{refreshNotice}</p>}
                {showRefreshFailure && (
                  <p className="text-xs text-warning">
                    Refresh failed. Existing indexed content is still available.
                    {freshness.next_refresh_at ? ` Next retry: ${fmtDate(freshness.next_refresh_at)}.` : ''}
                  </p>
                )}
              </div>
            )}

            {detail.error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {knowledgeErrorMessage(detail.error)}
              </div>
            )}

            <div className="grid gap-1.5">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Content preview</div>
              {detail.preview ? (
                <>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs">
                    {detail.preview.text}
                  </pre>
                  {detail.preview.truncated && (
                    <p className="text-[11px] text-muted-foreground">Preview truncated to the first characters.</p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {detail.source_type === 'file'
                    ? 'The original file stays in private storage and is not previewed here.'
                    : 'No stored content to preview yet.'}
                </p>
              )}
            </div>

            <KnowledgeSourceActions
              source={detail}
              canEdit={canEdit}
              busy={busy}
              onIngest={onIngest}
              onReindex={onReindex}
              onDelete={onDelete}
            />
          </div>
        )}
      </aside>
    </div>
  );
}
