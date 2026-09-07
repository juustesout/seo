import type { AutosaveStatus } from './useAutosave';
import { fmtDate } from '../../lib/ui';

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
  const pillClass =
    saveState === 'saving' ? 'busy' : saveState === 'failed' ? 'err' : saveState === 'saved' ? 'ok' : '';
  const savedLabel =
    saveState === 'saved' && savedAt
      ? `Saved ${fmtDate(savedAt)}`
      : SAVE_LABEL[saveState] ?? SAVE_LABEL.saved;

  return (
    <div className="ce-header">
      <div className="ce-row">
        <div className="ce-title-wrap">
          <input
            type="text"
            className="ce-title"
            value={title}
            disabled={!canEdit}
            placeholder="Untitled"
            onChange={(e) => onTitleChange(e.target.value)}
          />
          <span className="pill">{status}</span>
          <span className={`pill ${pillClass}`}>{savedLabel}</span>
        </div>
        <div className="ce-actions">
          {onViewPublications && (
            <button type="button" className="btn" onClick={onViewPublications} title="See every publish attempt of this article">
              History
            </button>
          )}
          <button type="button" className="btn" disabled={!canEdit || busy} onClick={onSaveNow}>
            Save
          </button>
          {status !== 'published' && (
            <button
              type="button"
              className="btn primary"
              disabled={!canEdit || busy}
              onClick={() => onStatusChange('published')}
            >
              Publish
            </button>
          )}
          {canDelete && (
            <button type="button" className="btn danger" disabled={busy} onClick={onDelete}>
              Delete
            </button>
          )}
        </div>
      </div>
      <div className="ce-sub">
        <span className="muted mono">{slug ? `/${slug}` : 'no slug yet'}</span>
        <span className="muted">{wordCount} words</span>
        {!canEdit && <span className="muted">Read-only project access.</span>}
      </div>
      {canEdit && (
        <div className="ce-statusrow">
          <span className="muted" style={{ fontSize: 12 }}>
            Status
          </span>
          <select value={status} disabled={busy} onChange={(e) => onStatusChange(e.target.value)}>
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
