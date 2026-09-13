/**
 * Source Detail drawer (KBUI2).
 *
 * The operational detail surface for one knowledge source, composed from small
 * focused sections rather than one long scroll of fields: Overview (identity +
 * collection), Content (safe preview), Processing (pipeline), Freshness (URL
 * facts + refresh), Activity (timestamps) and Actions. It is not a document
 * viewer - content is always bounded plain text and no storage path or private
 * object URL is ever shown.
 *
 * The drawer owns only the mutations that belong to it (collection change, the
 * delete confirmation, and polling while a background job runs); it delegates
 * refresh to the Freshness section. While a source is queued/processing/deleted
 * it asks the parent to refresh so the UI follows the real backend status and
 * never reports success before the server does.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgeCollectionDto, KnowledgeSourceDetailDto } from '@seo/contracts';
import { api } from '../../../lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SourceOverview } from './SourceOverview';
import { SourcePreview } from './SourcePreview';
import { SourceLifecycle } from './SourceLifecycle';
import { SourceFreshness } from './SourceFreshness';
import { SourceActivity } from './SourceActivity';
import { SourceActions } from './SourceActions';
import { SourceDeleteDialog } from './SourceDeleteDialog';
import { FRESHNESS_LABELS, freshnessBadgeVariant, SOURCE_STATUS_LABELS, SOURCE_TYPE_LABELS, statusBadgeVariant } from '../format';

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SourceDetail({
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
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  // Reset per-source transient state when a different source is opened.
  useEffect(() => {
    setActionError(null);
    setCollectionBusy(false);
    setConfirmDelete(false);
  }, [detail?.id]);

  // Follow the real lifecycle while a background job is in flight; stop as soon
  // as the source reaches a terminal state so we never poll an idle drawer.
  useEffect(() => {
    const status = detail?.status;
    if (status !== 'queued' && status !== 'processing' && status !== 'deleted') return;
    const t = window.setInterval(() => changedRef.current?.(), 3000);
    return () => window.clearInterval(t);
  }, [detail?.id, detail?.status]);

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
        setCollectionBusy(false);
      }
    },
    [detail, projectId, onChanged],
  );

  const displayError = actionError ?? error;
  const freshness = detail?.freshness;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose} role="presentation">
      <aside
        role="dialog"
        aria-label="Source detail"
        className="h-full w-full max-w-xl overflow-y-auto border-l bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{detail?.name ?? 'Source detail'}</h2>
            {detail && (
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">{SOURCE_TYPE_LABELS[detail.source_type]}</Badge>
                <Badge variant={statusBadgeVariant(detail.status)}>{SOURCE_STATUS_LABELS[detail.status]}</Badge>
                {detail.source_type === 'url' && freshness && (
                  <Badge variant={freshnessBadgeVariant(freshness.state)}>{FRESHNESS_LABELS[freshness.state]}</Badge>
                )}
                {detail.collection_name && <Badge variant="outline">{detail.collection_name}</Badge>}
              </div>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {displayError && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {displayError}
          </div>
        )}

        {detail && (
          <div className="grid gap-5">
            <SourceOverview
              detail={detail}
              canEdit={canEdit}
              collections={collections}
              collectionBusy={collectionBusy}
              onCollectionChange={(id) => void changeCollection(id)}
            />
            <SourcePreview detail={detail} />
            <SourceLifecycle detail={detail} />
            <SourceFreshness projectId={projectId} detail={detail} canEdit={canEdit} busy={busy} onChanged={onChanged} />
            <SourceActivity detail={detail} />
            <SourceActions
              detail={detail}
              canEdit={canEdit}
              busy={busy}
              onIngest={onIngest}
              onReindex={onReindex}
              onRequestDelete={() => setConfirmDelete(true)}
            />
          </div>
        )}
      </aside>

      {detail && (
        <SourceDeleteDialog
          open={confirmDelete}
          name={detail.name}
          sourceType={detail.source_type}
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            onDelete(detail.id);
          }}
        />
      )}
    </div>
  );
}
