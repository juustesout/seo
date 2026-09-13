/**
 * Delete-source confirmation dialog (KBUI2).
 *
 * Deleting a source is destructive, so it is always a deliberate two-step:
 * the user opens this dialog, sees exactly what will be removed (and, for a
 * file source, that the uploaded document and its indexed content go too), and
 * only then confirms. All copy is static; the source name is untrusted text
 * rendered as plain text.
 */
import { Button } from '@/components/ui/button';
import type { KnowledgeSourceType } from '@seo/contracts';

export function SourceDeleteDialog({
  open,
  name,
  sourceType,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  name: string;
  sourceType: KnowledgeSourceType;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel} role="presentation">
      <div
        role="dialog"
        aria-label="Delete source"
        className="w-full max-w-md rounded-xl border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">Delete "{name}"?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This removes the source from this project's knowledge base.
          {sourceType === 'file' ? ' The uploaded document and its indexed content will be removed.' : ''}
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </div>
  );
}
