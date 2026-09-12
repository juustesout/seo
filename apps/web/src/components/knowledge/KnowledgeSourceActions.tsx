/**
 * Status-aware lifecycle actions for one knowledge source (KB5).
 *
 * The buttons mirror exactly the lifecycle the backend owns - the UI never
 * decides a transition, it only offers the action the current status allows.
 * Delete is deliberately a two-step confirm so a mis-click can never remove a
 * source, and the request is only sent after the user confirms.
 */
import { useState } from 'react';
import type { KnowledgeSourceDto } from '@seo/contracts';
import { Button } from '@/components/ui/button';

export function KnowledgeSourceActions({
  source,
  canEdit,
  busy,
  onIngest,
  onReindex,
  onDelete,
}: {
  source: KnowledgeSourceDto;
  canEdit: boolean;
  busy: boolean;
  onIngest: (id: string) => void;
  onReindex: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!canEdit) return null;

  const disabled = busy;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {source.status === 'draft' && (
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onIngest(source.id)}>
          {source.source_type === 'url' ? 'Fetch' : 'Index'}
        </Button>
      )}
      {source.status === 'failed' && (
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onIngest(source.id)}>
          Retry
        </Button>
      )}
      {source.status === 'ready' && (
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onReindex(source.id)}>
          Reindex
        </Button>
      )}
      {source.status === 'queued' && (
        <Button size="sm" variant="outline" disabled>
          Queued…
        </Button>
      )}
      {source.status === 'processing' && (
        <Button size="sm" variant="outline" disabled>
          {source.source_type === 'url' ? 'Fetching…' : 'Processing…'}
        </Button>
      )}
      {source.status === 'deleted' && (
        <Button size="sm" variant="outline" disabled>
          Deleting…
        </Button>
      )}

      {source.status !== 'deleted' &&
        (confirming ? (
          <>
            <span className="text-xs text-muted-foreground">Delete source?</span>
            <Button
              size="sm"
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                setConfirming(false);
                onDelete(source.id);
              }}
            >
              Delete
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" className="text-destructive" disabled={disabled} onClick={() => setConfirming(true)}>
            Delete
          </Button>
        ))}
    </div>
  );
}
