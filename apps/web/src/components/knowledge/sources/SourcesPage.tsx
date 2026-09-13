/**
 * Knowledge Sources workspace (KBUI1, built on KB5/KB7/KB8; KBUI3 adds
 * URL-driven freshness/collection filters).
 *
 * The daily workplace for managing knowledge: compact filters, a bounded source
 * list with bulk selection, a status-aware detail drawer and one consistent
 * Add source entry (the dialog owns text/URL/file flows). All reads/writes go
 * through the project-scoped API; the browser never talks to Qdrant and never
 * sees a storage path, a content body outside the bounded preview, or a raw
 * error. Empty states are distinct: an empty knowledge base, filters that match
 * nothing, and a load failure each get their own honest message.
 *
 * The deep-linkable slice of the filter state (status, freshness, collection,
 * source) is mirrored to the URL through `onQueryChange`, so a health card or
 * activity link arrives at a real filtered view and survives a refresh. Type,
 * sort and the metadata search stay local to this view.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KNOWLEDGE_FRESHNESS_STATES,
  KNOWLEDGE_SOURCE_STATUSES,
  type KnowledgeCollectionDto,
  type KnowledgeFreshnessState,
  type KnowledgeSourceDetailDto,
  type KnowledgeSourceDto,
  type KnowledgeSourceStatus,
  type KnowledgeSourcesResponse,
} from '@seo/contracts';
import { api } from '../../../lib/api';
import { Button } from '@/components/ui/button';
import { SourceDetail } from './SourceDetail';
import { KnowledgeSourceFilters, type KnowledgeFilterState } from '../KnowledgeSourceFilters';
import { SourceList } from './SourceList';
import { KnowledgeBulkAssign, KnowledgeCollectionManager } from '../KnowledgeCollections';
import { AddSourceDialog, type AddSourceKind } from './AddSourceDialog';

const PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EMPTY_FILTERS: KnowledgeFilterState = {
  type: '',
  status: '',
  freshness: '',
  search: '',
  sort: 'updated_desc',
  collectionId: '',
  uncategorized: false,
};

const VALID_STATUSES = new Set<string>(KNOWLEDGE_SOURCE_STATUSES);
const VALID_FRESHNESS = new Set<string>(KNOWLEDGE_FRESHNESS_STATES);

/** The URL-restorable slice of this view's state (KBUI3). */
export interface SourcesQueryParams {
  status: string | null;
  freshness: string | null;
  collection: string | null;
  uncategorized: string | null;
  source: string | null;
}

function buildQuery(filters: KnowledgeFilterState, source: string | null): SourcesQueryParams {
  return {
    status: filters.status || null,
    freshness: filters.freshness || null,
    collection: filters.collectionId || null,
    uncategorized: filters.uncategorized ? 'true' : null,
    source,
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SourcesPage({
  projectId,
  canEdit,
  configured,
  collections = [],
  onCollectionsChanged,
  initialStatus = '',
  initialFreshness = '',
  initialCollectionId = '',
  initialUncategorized = false,
  initialSourceId = null,
  onDiscover,
  onQueryChange,
}: {
  projectId: string;
  canEdit: boolean;
  configured: boolean;
  collections?: KnowledgeCollectionDto[];
  onCollectionsChanged?: () => void;
  initialStatus?: string;
  initialFreshness?: string;
  initialCollectionId?: string;
  initialUncategorized?: boolean;
  initialSourceId?: string | null;
  onDiscover?: () => void;
  onQueryChange?: (params: SourcesQueryParams) => void;
}) {
  const [filters, setFilters] = useState<KnowledgeFilterState>(() => ({
    ...EMPTY_FILTERS,
    status: initialStatus && VALID_STATUSES.has(initialStatus) ? (initialStatus as KnowledgeSourceStatus) : '',
    freshness:
      initialFreshness && VALID_FRESHNESS.has(initialFreshness) ? (initialFreshness as KnowledgeFreshnessState) : '',
    collectionId: initialCollectionId && UUID_RE.test(initialCollectionId) ? initialCollectionId : '',
    uncategorized: initialUncategorized && !initialCollectionId,
  }));
  const [searchInput, setSearchInput] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<KnowledgeSourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [collectionBusy, setCollectionBusy] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<AddSourceKind | null>(null);
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeSourceDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const openedRef = useRef<string | null>(null);
  // Refs so async/close handlers always emit the latest filter state, even when
  // they were created in an earlier render (e.g. a 404 closing a deep link).
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.type) params.set('type', filters.type);
      if (filters.status) params.set('status', filters.status);
      if (filters.freshness) params.set('freshness', filters.freshness);
      if (filters.search.trim()) params.set('search', filters.search.trim());
      if (filters.uncategorized) params.set('uncategorized', 'true');
      else if (filters.collectionId) params.set('collection_id', filters.collectionId);
      params.set('sort', filters.sort);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));
      const res = await api<KnowledgeSourcesResponse>(`/projects/${projectId}/knowledge/sources?${params.toString()}`);
      setData(res);
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, filters, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // Mirror a deep-linked query (from the Overview, a shared URL, or browser
  // back/forward) into the local filters. No-ops when nothing actually changes
  // so it can never loop with the emit below.
  useEffect(() => {
    setFilters((f) => {
      const next = { ...f };
      let changed = false;
      if (initialStatus && VALID_STATUSES.has(initialStatus) && next.status !== initialStatus) {
        next.status = initialStatus as KnowledgeSourceStatus;
        changed = true;
      }
      if (initialFreshness && VALID_FRESHNESS.has(initialFreshness) && next.freshness !== initialFreshness) {
        next.freshness = initialFreshness as KnowledgeFreshnessState;
        changed = true;
      }
      if (initialCollectionId && UUID_RE.test(initialCollectionId) && next.collectionId !== initialCollectionId) {
        next.collectionId = initialCollectionId;
        next.uncategorized = false;
        changed = true;
      } else if (initialUncategorized && !next.uncategorized) {
        next.uncategorized = true;
        next.collectionId = '';
        changed = true;
      }
      return changed ? next : f;
    });
    setOffset(0);
  }, [initialStatus, initialFreshness, initialCollectionId, initialUncategorized]);

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setFilters((f) => (f.search === searchInput ? f : { ...f, search: searchInput }));
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const busy = (data?.items ?? []).some(
    (s) => s.status === 'queued' || s.status === 'processing' || s.status === 'deleted',
  );

  // Poll only while work is actually in flight, so the list stays honest.
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => {
      void load();
    }, 4000);
    return () => window.clearInterval(id);
  }, [busy, load]);

  const applyFilter = useCallback(
    (patch: Partial<KnowledgeFilterState>) => {
      const next = { ...filters, ...patch };
      setFilters(next);
      setOffset(0);
      const touchesQuery =
        'status' in patch || 'freshness' in patch || 'collectionId' in patch || 'uncategorized' in patch;
      if (touchesQuery) {
        // A filter change invalidates whatever detail is open.
        setSelectedId(null);
        setDetail(null);
        setDetailError(null);
        openedRef.current = null;
        onQueryChange?.(buildQuery(next, null));
      }
    },
    [filters, onQueryChange],
  );

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setSearchInput('');
    setOffset(0);
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    openedRef.current = null;
    onQueryChange?.(buildQuery(EMPTY_FILTERS, null));
  }, [onQueryChange]);

  const closeDetail = useCallback(() => {
    const hadSource = openedRef.current !== null;
    openedRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    if (hadSource) onQueryChange?.(buildQuery(filtersRef.current, null));
  }, [onQueryChange]);

  const openSourceById = useCallback(
    async (id: string) => {
      openedRef.current = id;
      setSelectedId(id);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const next = await api<KnowledgeSourceDetailDto>(`/projects/${projectId}/knowledge/sources/${id}`);
        // Ignore a late response for a source the user has since navigated away
        // from, so a slow request can never overwrite the open source.
        if (openedRef.current !== id) return;
        setDetail(next);
      } catch (e) {
        if (openedRef.current !== id) return;
        // A source that no longer exists must not leave an endless error
        // drawer: close it and drop the deep link so a refresh stays clean.
        if ((e as { status?: number } | null)?.status === 404) {
          closeDetail();
        } else {
          setDetailError(message(e));
        }
      } finally {
        if (openedRef.current === id) setDetailLoading(false);
      }
    },
    [projectId, closeDetail],
  );

  const openDetail = useCallback(
    (source: KnowledgeSourceDto) => {
      onQueryChange?.(buildQuery(filters, source.id));
      void openSourceById(source.id);
    },
    [filters, onQueryChange, openSourceById],
  );

  // Deep link straight to one source (from the Overview or a shared URL) and
  // restore it after a browser refresh; skip if it is already open.
  useEffect(() => {
    if (!initialSourceId || openedRef.current === initialSourceId) return;
    void openSourceById(initialSourceId);
  }, [initialSourceId, openSourceById]);

  const refreshDetail = useCallback(
    async (id: string) => {
      try {
        const next = await api<KnowledgeSourceDetailDto>(`/projects/${projectId}/knowledge/sources/${id}`);
        if (openedRef.current === id) setDetail(next);
      } catch {
        // keep the current detail; the list reload already surfaced the state
      }
    },
    [projectId],
  );

  const handleDetailChanged = useCallback(() => {
    void load();
    onCollectionsChanged?.();
    if (selectedId) void refreshDetail(selectedId);
  }, [load, onCollectionsChanged, selectedId, refreshDetail]);

  const runCollection = useCallback(
    async (fn: () => Promise<void>) => {
      setCollectionBusy(true);
      setError(null);
      try {
        await fn();
        onCollectionsChanged?.();
      } catch (e) {
        setError(message(e));
      } finally {
        setCollectionBusy(false);
      }
    },
    [onCollectionsChanged],
  );

  const createCollection = useCallback(
    (collectionName: string, description: string | null) =>
      runCollection(async () => {
        await api(`/projects/${projectId}/knowledge/collections`, {
          method: 'POST',
          body: { name: collectionName, description },
        });
      }),
    [projectId, runCollection],
  );

  const renameCollection = useCallback(
    (id: string, newName: string) =>
      runCollection(async () => {
        await api(`/projects/${projectId}/knowledge/collections/${id}`, {
          method: 'PATCH',
          body: { name: newName },
        });
      }),
    [projectId, runCollection],
  );

  const deleteCollection = useCallback(
    (id: string) =>
      runCollection(async () => {
        await api(`/projects/${projectId}/knowledge/collections/${id}`, { method: 'DELETE' });
        setFilters((f) => (f.collectionId === id ? { ...f, collectionId: '' } : f));
      }),
    [projectId, runCollection],
  );

  const toggleChecked = useCallback((id: string) => {
    setCheckedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }, []);

  const bulkMove = useCallback(
    async (collectionId: string | null) => {
      if (checkedIds.length === 0) return;
      setBulkBusy(true);
      setError(null);
      try {
        await api(`/projects/${projectId}/knowledge/sources/bulk`, {
          method: 'POST',
          body: { source_ids: checkedIds, collection_id: collectionId },
        });
        setCheckedIds([]);
        await load();
        onCollectionsChanged?.();
      } catch (e) {
        setError(message(e));
      } finally {
        setBulkBusy(false);
      }
    },
    [projectId, checkedIds, load, onCollectionsChanged],
  );

  const runAction = useCallback(
    async (id: string, action: 'ingest' | 'reindex' | 'delete') => {
      setBusyId(id);
      setError(null);
      try {
        if (action === 'delete') {
          await api(`/projects/${projectId}/knowledge/sources/${id}`, { method: 'DELETE' });
          setCheckedIds((ids) => ids.filter((x) => x !== id));
          if (selectedId === id) closeDetail();
        } else {
          await api(`/projects/${projectId}/knowledge/sources/${id}/${action}`, { method: 'POST', body: {} });
        }
        await load();
        if (action !== 'delete' && selectedId === id) void refreshDetail(id);
      } catch (e) {
        setError(message(e));
      } finally {
        setBusyId(null);
      }
    },
    [projectId, selectedId, closeDetail, load, refreshDetail],
  );

  const openAdd = (kind: AddSourceKind | null) => {
    setAddKind(kind);
    setAddOpen(true);
  };

  const total = data?.total ?? 0;
  const limit = data?.limit ?? PAGE_SIZE;
  const canPrev = offset > 0;
  const canNext = offset + limit < total;
  const summary = data?.summary ?? null;
  const hasFilters = Boolean(
    filters.type ||
      filters.status ||
      filters.freshness ||
      filters.search.trim() ||
      filters.collectionId ||
      filters.uncategorized,
  );
  const showEmpty = !loading && data !== null && data.items.length === 0;

  return (
    <>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Sources</h2>
          {canEdit && (
            <Button size="sm" onClick={() => openAdd(null)}>
              + Add source
            </Button>
          )}
        </div>

        {error && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}

        {data && !configured && (
          <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
            Knowledge is not usable on this server yet. {data.note ?? ''}
          </div>
        )}

        <KnowledgeSourceFilters
          value={{ ...filters, search: searchInput }}
          onChange={(patch) => {
            if (patch.search !== undefined) {
              setSearchInput(patch.search);
              return;
            }
            applyFilter(patch);
          }}
          summary={summary}
          total={total}
          collections={collections}
        />

        {canEdit && (
          <details className="rounded-lg border bg-muted/20">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Manage collections
            </summary>
            <div className="px-3 pb-3">
              <KnowledgeCollectionManager
                collections={collections}
                busy={collectionBusy}
                onCreate={(collectionName, description) => createCollection(collectionName, description)}
                onRename={(id, newName) => renameCollection(id, newName)}
                onDelete={(id) => deleteCollection(id)}
              />
            </div>
          </details>
        )}

        {canEdit && (
          <KnowledgeBulkAssign
            collections={collections}
            count={checkedIds.length}
            busy={bulkBusy}
            onMove={(collectionId) => bulkMove(collectionId)}
            onClear={() => setCheckedIds([])}
          />
        )}

        {loading && !data ? (
          <p className="text-sm text-muted-foreground">Loading sources…</p>
        ) : showEmpty && !hasFilters && (summary?.total ?? 0) === 0 ? (
          <div className="grid gap-2 rounded-lg border bg-muted/20 px-4 py-8 text-center">
            <div className="text-sm font-medium">Your knowledge base is empty</div>
            <p className="text-sm text-muted-foreground">
              Add text, upload a document or connect a website to start building project knowledge.
            </p>
            {canEdit && (
              <div className="mt-1 flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => openAdd(null)}>
                  Add source
                </Button>
                {onDiscover && (
                  <Button size="sm" variant="outline" onClick={onDiscover}>
                    Discover website
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : showEmpty ? (
          <div className="grid gap-2 rounded-lg border bg-muted/20 px-4 py-8 text-center">
            <div className="text-sm text-muted-foreground">No sources match these filters.</div>
            <div>
              <Button size="sm" variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          </div>
        ) : (
          <SourceList
            items={data?.items ?? []}
            selectedId={selectedId}
            selectable={canEdit}
            selectedIds={checkedIds}
            onToggleSelect={toggleChecked}
            onSelect={openDetail}
          />
        )}

        {total > limit && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {offset + 1}-{Math.min(offset + limit, total)} of {total}
            </span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" disabled={!canPrev || loading} onClick={() => setOffset(Math.max(0, offset - limit))}>
                Previous
              </Button>
              <Button size="sm" variant="outline" disabled={!canNext || loading} onClick={() => setOffset(offset + limit)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      <AddSourceDialog
        projectId={projectId}
        open={addOpen}
        initialKind={addKind}
        collections={collections}
        onClose={() => {
          setAddOpen(false);
          if (pendingOpenId) {
            onQueryChange?.(buildQuery(filters, pendingOpenId));
            void openSourceById(pendingOpenId);
            setPendingOpenId(null);
          }
        }}
        onCreated={(id) => {
          setPendingOpenId(id);
          void load();
        }}
      />

      {selectedId && (
        <SourceDetail
          projectId={projectId}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          canEdit={canEdit}
          busy={busyId === selectedId}
          collections={collections}
          onClose={closeDetail}
          onIngest={(id) => void runAction(id, 'ingest')}
          onReindex={(id) => void runAction(id, 'reindex')}
          onDelete={(id) => void runAction(id, 'delete')}
          onChanged={handleDetailChanged}
        />
      )}
    </>
  );
}
