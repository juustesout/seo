/**
 * Knowledge collections - optional source organization (KB8).
 *
 * Collections are organizational metadata only: a source belongs to at most one
 * and "uncategorized" is a normal state. These controls never change a source's
 * lifecycle, and deleting a collection is a two-step confirm that makes clear
 * the sources themselves are kept. All requests go through the project-scoped
 * API; nothing here reads vectors or storage. Collection names/descriptions are
 * untrusted text rendered as plain text.
 */
import { useState, type FormEvent } from 'react';
import { KNOWLEDGE_COLLECTION_DESCRIPTION_MAX_CHARS, KNOWLEDGE_COLLECTION_NAME_MAX_CHARS } from '@seo/contracts';
import type { KnowledgeCollectionDto } from '@seo/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm text-foreground';

/** Sentinel value for the "uncategorized" option in a collection selector. */
export const UNCATEGORIZED = '__uncategorized__';

export interface OrganizationFilter {
  collectionId: string;
  uncategorized: boolean;
}

/**
 * All sources / Uncategorized / one collection selector. Omitted means every
 * source; the two filters are mutually exclusive, mirroring the API.
 */
export function KnowledgeOrganizationFilter({
  collections = [],
  value,
  onChange,
  disabled,
}: {
  collections?: KnowledgeCollectionDto[];
  value: OrganizationFilter;
  onChange: (patch: Partial<OrganizationFilter>) => void;
  disabled?: boolean;
}) {
  const selected = value.uncategorized ? UNCATEGORIZED : value.collectionId;
  return (
    <select
      aria-label="Filter by collection"
      className={selectClass}
      value={selected}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.value;
        if (next === '') onChange({ collectionId: '', uncategorized: false });
        else if (next === UNCATEGORIZED) onChange({ collectionId: '', uncategorized: true });
        else onChange({ collectionId: next, uncategorized: false });
      }}
    >
      <option value="">All sources</option>
      <option value={UNCATEGORIZED}>Uncategorized</option>
      {collections.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({c.sourceCount})
        </option>
      ))}
    </select>
  );
}

/**
 * Create + rename + delete collections. Rename and delete are per-row; delete
 * requires confirmation and states explicitly that sources are not deleted.
 */
export function KnowledgeCollectionManager({
  collections = [],
  busy,
  onCreate,
  onRename,
  onDelete,
}: {
  collections?: KnowledgeCollectionDto[];
  busy: boolean;
  onCreate: (name: string, description: string | null) => Promise<void> | void;
  onRename: (id: string, name: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      await onCreate(name.trim(), description.trim() ? description.trim() : null);
      setName('');
      setDescription('');
    } finally {
      setCreating(false);
    }
  };

  const submitRename = async (id: string) => {
    if (!renameValue.trim()) return;
    await onRename(id, renameValue.trim());
    setRenamingId(null);
    setRenameValue('');
  };

  return (
    <div className="grid gap-2 rounded-lg border bg-muted/20 p-3" role="group" aria-label="Collections">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Collections</div>

      {collections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No collections yet. Sources are uncategorized by default.</p>
      ) : (
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {collections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-1.5">
              {renamingId === c.id ? (
                <div className="flex flex-1 flex-wrap items-center gap-1.5">
                  <Input
                    aria-label="Collection name"
                    value={renameValue}
                    maxLength={KNOWLEDGE_COLLECTION_NAME_MAX_CHARS}
                    onChange={(e) => setRenameValue(e.target.value)}
                    className="h-8 min-w-[140px] flex-1"
                  />
                  <Button size="sm" disabled={busy || !renameValue.trim()} onClick={() => void submitRename(c.id)}>
                    Save
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRenamingId(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.sourceCount} {c.sourceCount === 1 ? 'source' : 'sources'}
                      {c.description ? ` · ${c.description}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {confirmingId === c.id ? (
                      <>
                        <span className="text-xs text-muted-foreground">Delete collection? Sources are kept.</span>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => {
                            setConfirmingId(null);
                            void onDelete(c.id);
                          }}
                        >
                          Delete
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setConfirmingId(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setRenamingId(c.id);
                            setRenameValue(c.name);
                          }}
                        >
                          Rename
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive"
                          disabled={busy}
                          onClick={() => setConfirmingId(c.id)}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="flex flex-wrap items-center gap-1.5" onSubmit={submitCreate}>
        <Input
          type="text"
          aria-label="New collection name"
          placeholder="New collection name"
          value={name}
          maxLength={KNOWLEDGE_COLLECTION_NAME_MAX_CHARS}
          onChange={(e) => setName(e.target.value)}
          className="h-8 min-w-[140px] flex-1"
        />
        <Input
          type="text"
          aria-label="New collection description"
          placeholder="Description (optional)"
          value={description}
          maxLength={KNOWLEDGE_COLLECTION_DESCRIPTION_MAX_CHARS}
          onChange={(e) => setDescription(e.target.value)}
          className="h-8 min-w-[140px] flex-1"
        />
        <Button type="submit" size="sm" disabled={creating || busy || !name.trim()}>
          {creating ? 'Creating…' : 'Create collection'}
        </Button>
      </form>
    </div>
  );
}

/** Move the current selection into a collection, or out of every collection. */
export function KnowledgeBulkAssign({
  collections = [],
  count,
  busy,
  onMove,
  onClear,
}: {
  collections?: KnowledgeCollectionDto[];
  count: number;
  busy: boolean;
  onMove: (collectionId: string | null) => Promise<void> | void;
  onClear: () => void;
}) {
  const [target, setTarget] = useState('');
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
      <span className="text-sm text-muted-foreground">
        {count} selected
      </span>
      <select
        aria-label="Move to collection"
        className={selectClass}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value="">Move to…</option>
        <option value={UNCATEGORIZED}>Uncategorized</option>
        {collections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={busy || !target}
        onClick={() => void onMove(target === UNCATEGORIZED ? null : target)}
      >
        Move
      </Button>
      <Button size="sm" variant="outline" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
