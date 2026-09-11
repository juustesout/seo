/**
 * Header of the Content Studio editor: title, status pill + selector, autosave
 * state, word count, slug, and the primary actions (Save / Publish / Delete /
 * publication History). Save state comes from the parent's autosave hook and is
 * shown honestly (saving / saved / failed). Role gates: read-only users cannot
 * edit the title or status, and Delete is only offered when the parent allows
 * it (admin/owner).
 */
import type { AutosaveStatus } from './useAutosave';
import { fmtDate } from '../../lib/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const SAVE_LABEL: Record<AutosaveStatus, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  failed: 'Save failed',
};

interface ContentEditorHeaderProps {
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
  onViewPublications?: () => void;
}

export function ContentEditorHeader({
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
  onViewPublications,
}: ContentEditorHeaderProps) {
  const saveVariant =
    saveState === 'saving' ? 'warning' : saveState === 'failed' ? 'destructive' : saveState === 'saved' ? 'success' : 'outline';
  const savedLabel =
    saveState === 'saved' && savedAt
      ? `Saved ${fmtDate(savedAt)}`
      : SAVE_LABEL[saveState] ?? SAVE_LABEL.saved;

  return (
    <div className="mb-3 grid gap-2">
      <div className="flex flex-wrap items-center gap-2.5">
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
          <Badge variant={saveVariant}>{savedLabel}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {onViewPublications && (
            <Button variant="outline" onClick={onViewPublications} title="See every publish attempt of this article">
              History
            </Button>
          )}
          <Button variant="outline" disabled={!canEdit || busy} onClick={onSaveNow}>
            Save
          </Button>
          {status !== 'published' && (
            <Button disabled={!canEdit || busy} onClick={() => onStatusChange('published')}>
              Publish
            </Button>
          )}
          {canDelete && (
            <Button variant="destructive" disabled={busy} onClick={onDelete}>
              Delete
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-3.5 px-0.5">
        <span className="font-mono text-xs text-muted-foreground">{slug ? `/${slug}` : 'no slug yet'}</span>
        <span className="text-sm text-muted-foreground">{wordCount} words</span>
        {!canEdit && <span className="text-sm text-muted-foreground">Read-only project access.</span>}
      </div>
      {canEdit && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Status</span>
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={status}
            disabled={busy}
            onChange={(e) => onStatusChange(e.target.value)}
          >
            {['draft', 'in_review', 'published', 'archived'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
