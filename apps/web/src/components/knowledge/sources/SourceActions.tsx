/**
 * Source Detail "Actions" section (KBUI2).
 *
 * Every lifecycle action for one source in a single, lifecycle-aware place. The
 * UI mirrors exactly what the backend allows - it never offers a transition
 * that would be rejected: draft sources can be fetched/indexed, failed ones can
 * be retried, ready ones reindexed, and queued/processing/deleted sources only
 * report their in-flight state. Failed sources get a plain-language explanation
 * using the shared safe error taxonomy. Delete is a deliberate confirm handled
 * by the parent dialog. Viewers see the failure explanation but no controls.
 */
import { knowledgeErrorMessage, type KnowledgeSourceDetailDto } from '@seo/contracts';
import { Button } from '@/components/ui/button';
import { SourceSection } from './SourceSection';

export function SourceActions({
  detail,
  canEdit,
  busy,
  onIngest,
  onReindex,
  onRequestDelete,
}: {
  detail: KnowledgeSourceDetailDto;
  canEdit: boolean;
  busy: boolean;
  onIngest: (id: string) => void;
  onReindex: (id: string) => void;
  onRequestDelete: () => void;
}) {
  if (!canEdit && detail.status !== 'failed') return null;

  const disabled = busy;

  return (
    <SourceSection title="Actions">
      {detail.status === 'failed' && (
        <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <div className="text-sm font-medium text-destructive">This source could not be processed.</div>
          {detail.error && <p className="text-xs text-muted-foreground">{knowledgeErrorMessage(detail.error)}</p>}
          {canEdit && (
            <div>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => onIngest(detail.id)}>
                Retry
              </Button>
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-1.5">
          {detail.status === 'draft' && (
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => onIngest(detail.id)}>
              {detail.source_type === 'url' ? 'Fetch and index' : 'Index'}
            </Button>
          )}
          {detail.status === 'ready' && (
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => onReindex(detail.id)}>
              Reindex
            </Button>
          )}
          {detail.status === 'queued' && (
            <Button size="sm" variant="outline" disabled>
              Queued…
            </Button>
          )}
          {detail.status === 'processing' && (
            <Button size="sm" variant="outline" disabled>
              {detail.source_type === 'url' ? 'Fetching…' : 'Processing…'}
            </Button>
          )}
          {detail.status === 'deleted' && (
            <Button size="sm" variant="outline" disabled>
              Deleting…
            </Button>
          )}

          {detail.status !== 'deleted' && (
            <Button size="sm" variant="outline" className="text-destructive" disabled={disabled} onClick={onRequestDelete}>
              Delete
            </Button>
          )}
        </div>
      )}
    </SourceSection>
  );
}
