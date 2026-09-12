/**
 * Knowledge Library (KB5) - the project's source management surface.
 *
 * Summary + filters + metadata search + bounded, paginated source list with a
 * detail drawer and status-aware lifecycle actions. All reads/writes go through
 * the project-scoped API; the browser never talks to Qdrant and never sees a
 * storage path, a content body outside the bounded preview, or a raw error.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { KnowledgeSourceDetailDto, KnowledgeSourceDto, KnowledgeSourcesResponse } from '@seo/contracts';
import { api, apiRaw } from '../../lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { KnowledgeSourceDetail } from './KnowledgeSourceDetail';
import { KnowledgeSourceFilters, type KnowledgeFilterState } from './KnowledgeSourceFilters';
import { KnowledgeSourceList } from './KnowledgeSourceList';
import { KNOWLEDGE_FILE_ACCEPT } from './format';

const PAGE_SIZE = 50;

const EMPTY_FILTERS: KnowledgeFilterState = { type: '', status: '', search: '', sort: 'updated_desc' };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function KnowledgeLibrary({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [filters, setFilters] = useState<KnowledgeFilterState>(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<KnowledgeSourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busyAction, setBusyAction] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeSourceDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.type) params.set('type', filters.type);
      if (filters.status) params.set('status', filters.status);
      if (filters.search.trim()) params.set('search', filters.search.trim());
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

  const applyFilter = useCallback((patch: Partial<KnowledgeFilterState>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setOffset(0);
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
  }, []);

  const openDetail = useCallback(
    async (source: KnowledgeSourceDto) => {
      setSelectedId(source.id);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        setDetail(await api<KnowledgeSourceDetailDto>(`/projects/${projectId}/knowledge/sources/${source.id}`));
      } catch (e) {
        setDetailError(message(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [projectId],
  );

  const refreshDetail = useCallback(
    async (id: string) => {
      try {
        setDetail(await api<KnowledgeSourceDetailDto>(`/projects/${projectId}/knowledge/sources/${id}`));
      } catch {
        // keep the current detail; the list reload already surfaced the state
      }
    },
    [projectId],
  );

  const runAction = useCallback(
    async (id: string, action: 'ingest' | 'reindex' | 'delete') => {
      setBusyId(id);
      setError(null);
      try {
        if (action === 'delete') {
          await api(`/projects/${projectId}/knowledge/sources/${id}`, { method: 'DELETE' });
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

  const addSource = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busyAction) return;
    const trimmedText = text.trim();
    const trimmedUrl = url.trim();
    const sourceType = trimmedText ? 'text' : 'url';
    if (sourceType === 'url' && !trimmedUrl) return;
    setBusyAction(true);
    setError(null);
    try {
      await api(`/projects/${projectId}/knowledge/sources`, {
        method: 'POST',
        body: { name: name.trim(), source_type: sourceType, url: trimmedUrl || null, text: trimmedText || null },
      });
      setName('');
      setUrl('');
      setText('');
      await load();
    } catch (e2) {
      setError(message(e2));
    } finally {
      setBusyAction(false);
    }
  };

  const uploadFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busyAction) return;
    setBusyAction(true);
    setError(null);
    try {
      await apiRaw(`/projects/${projectId}/knowledge/sources/upload`, file, { filename: file.name });
      await load();
    } catch (e2) {
      setError(message(e2));
    } finally {
      setBusyAction(false);
    }
  };

  const configured = data?.configured ?? false;
  const total = data?.total ?? 0;
  const limit = data?.limit ?? PAGE_SIZE;
  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Knowledge Library</CardTitle>
          <CardDescription>
            Reference text, URLs and documents indexed per project into the isolated vector base. They are offered as
            optional context to AI actions - never as the source of truth for your content.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
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
            summary={data?.summary ?? null}
            total={total}
          />

          {canEdit && configured && (
            <form className="grid gap-2 rounded-lg border bg-muted/20 p-3" onSubmit={addSource}>
              <Input
                type="text"
                placeholder="Title (e.g. Style guide, competitor note)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                required
              />
              <Input
                type="text"
                placeholder="URL of the reference (optional)"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                maxLength={2000}
              />
              <Textarea
                placeholder="Content to index (paste a reference document or write notes)…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={100000}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" disabled={busyAction || !name.trim() || (!text.trim() && !url.trim())}>
                  {busyAction ? 'Adding…' : 'Add source'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busyAction}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Upload file
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={KNOWLEDGE_FILE_ACCEPT}
                  className="hidden"
                  onChange={uploadFile}
                />
                <span className="text-[11px] text-muted-foreground">TXT, Markdown, PDF or DOCX (max 10 MB).</span>
              </div>
            </form>
          )}

          {loading && !data ? (
            <p className="text-sm text-muted-foreground">Loading sources…</p>
          ) : (
            <KnowledgeSourceList
              items={data?.items ?? []}
              selectedId={selectedId}
              canEdit={canEdit}
              busyId={busyId}
              onSelect={(s) => void openDetail(s)}
              onIngest={(id) => void runAction(id, 'ingest')}
              onReindex={(id) => void runAction(id, 'reindex')}
              onDelete={(id) => void runAction(id, 'delete')}
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
        </CardContent>
      </Card>

      {selectedId && (
        <KnowledgeSourceDetail
          detail={detail}
          loading={detailLoading}
          error={detailError}
          canEdit={canEdit}
          busy={busyId === selectedId}
          onClose={closeDetail}
          onIngest={(id) => void runAction(id, 'ingest')}
          onReindex={(id) => void runAction(id, 'reindex')}
          onDelete={(id) => void runAction(id, 'delete')}
        />
      )}
    </>
  );
}
