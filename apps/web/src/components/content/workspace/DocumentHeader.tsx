/**
 * Single document header for the editor workspace.
 *
 * Consolidates what used to be split across the document header and a canvas
 * toolbar: one title, one status, one save indicator and one action cluster.
 * Primary actions stay visible (Insert, Preview, Save, Publish); secondary and
 * destructive actions (History, Schedule, status, Delete) live in an overflow
 * menu so the header stays calm. Role gates and the status-based publish
 * semantics are unchanged.
 */
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import type { AutosaveStatus } from '../useAutosave';
import { fmtDate } from '../../../lib/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const SAVE_LABEL: Record<AutosaveStatus, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  failed: 'Save failed',
};

export interface DocumentHeaderProps {
  title: string;
  onTitleChange: (title: string) => void;
  status: string;
  onStatusChange: (status: string) => void;
  saveState: AutosaveStatus;
  wordCount: number;
  slug: string | null;
  savedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
  busy: boolean;
  onSaveNow: () => void;
  onDelete: () => void;
  onBack: () => void;
  onViewPublications?: () => void;
  onOpenCalendar?: () => void;
  previewOpen: boolean;
  onTogglePreview: () => void;
  railOpen: boolean;
  onToggleRail: () => void;
}

const STATUSES = ['draft', 'in_review', 'published', 'archived'];

export function DocumentHeader({
  title,
  onTitleChange,
  status,
  onStatusChange,
  saveState,
  wordCount,
  slug,
  savedAt,
  canEdit,
  canDelete,
  busy,
  onSaveNow,
  onDelete,
  onBack,
  onViewPublications,
  onOpenCalendar,
  previewOpen,
  onTogglePreview,
  railOpen,
  onToggleRail,
}: DocumentHeaderProps) {
  const saveVariant =
    saveState === 'saving' ? 'warning' : saveState === 'failed' ? 'destructive' : saveState === 'saved' ? 'success' : 'outline';
  const savedLabel =
    saveState === 'saved' && savedAt ? `Saved ${fmtDate(savedAt)}` : SAVE_LABEL[saveState] ?? SAVE_LABEL.saved;

  return (
    <header className="grid gap-2" data-testid="document-header">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="outline" size="sm" onClick={onBack} title="Back to the content list">
          <ArrowLeft /> Back
        </Button>
        <div className="flex min-w-[260px] flex-1 flex-wrap items-center gap-2.5">
          <Input
            type="text"
            className="h-auto min-w-[240px] flex-1 border-transparent bg-transparent px-2 py-1.5 text-lg font-bold shadow-none focus-visible:border-ring focus-visible:bg-muted/40 focus-visible:ring-[3px]"
            value={title}
            disabled={!canEdit}
            placeholder="Untitled"
            onChange={(e) => onTitleChange(e.target.value)}
          />
          <Badge variant="outline">{status}</Badge>
          <Badge variant={saveVariant} data-testid="document-save-state">
            {savedLabel}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {canEdit && (
            <Button
              variant={railOpen ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={railOpen}
              onClick={onToggleRail}
              title="Insert a composition element into the document"
            >
              Insert
            </Button>
          )}
          <Button
            variant={previewOpen ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={previewOpen}
            onClick={onTogglePreview}
            title="Preview the rendered document without leaving the editor"
          >
            {previewOpen ? 'Editing' : 'Preview'}
          </Button>
          <Button variant="outline" size="sm" disabled={!canEdit || busy} onClick={onSaveNow}>
            Save
          </Button>
          {status !== 'published' && (
            <Button size="sm" disabled={!canEdit || busy} onClick={() => onStatusChange('published')}>
              Publish
            </Button>
          )}
          <details className="relative">
            <summary
              className="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border bg-background px-2.5 text-sm shadow-xs outline-none hover:bg-accent [&::-webkit-details-marker]:hidden"
              title="More document actions"
            >
              <MoreHorizontal className="size-4" />
              More
            </summary>
            <div className="absolute right-0 top-[calc(100%+6px)] z-20 flex min-w-[220px] flex-col gap-2 rounded-lg border bg-card p-3 shadow-lg">
              {canEdit && (
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Status
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    value={status}
                    disabled={busy}
                    onChange={(e) => onStatusChange(e.target.value)}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {onViewPublications && (
                <Button variant="outline" size="sm" className="justify-start" onClick={onViewPublications}>
                  Publication history
                </Button>
              )}
              {onOpenCalendar && (
                <Button variant="outline" size="sm" className="justify-start" onClick={onOpenCalendar}>
                  Schedule calendar
                </Button>
              )}
              {canDelete && (
                <Button variant="destructive" size="sm" className="justify-start" disabled={busy} onClick={onDelete}>
                  Delete article
                </Button>
              )}
            </div>
          </details>
        </div>
      </div>
      <div className="flex flex-wrap gap-3.5 px-0.5">
        <span className="font-mono text-xs text-muted-foreground">{slug ? `/${slug}` : 'no slug yet'}</span>
        <span className="text-sm text-muted-foreground">{wordCount} words</span>
        {!canEdit && <span className="text-sm text-muted-foreground">Read-only project access.</span>}
      </div>
    </header>
  );
}
