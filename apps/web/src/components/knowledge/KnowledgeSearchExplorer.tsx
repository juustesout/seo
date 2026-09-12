/**
 * Knowledge Search Explorer (KB6) - a direct retrieval debugger for the
 * existing knowledge base.
 *
 * The user submits a query and the API returns a canonical, attributed result
 * set: source name/type, an optional chunk reference, a bounded plain-text
 * excerpt and the retrieval score. Scores are similarity/ranking signals from
 * the provider - never confidence or truth. Retrieved text is treated as
 * untrusted data: it is rendered as plain text only (no HTML, no markdown, no
 * auto-links), and managed results can be opened in the shared KB5 Source
 * Detail surface. The browser never talks to Qdrant directly.
 */
import { useCallback, useState, type FormEvent } from 'react';
import {
  KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  KNOWLEDGE_SEARCH_QUERY_MAX_CHARS,
  KNOWLEDGE_SOURCE_TYPES,
  type KnowledgeSearchResponse,
  type KnowledgeSourceDetailDto,
  type KnowledgeSourceType,
} from '@seo/contracts';
import { api } from '../../lib/api';
import { Empty } from '../../lib/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { KnowledgeSourceDetail } from './KnowledgeSourceDetail';
import { SOURCE_TYPE_LABELS } from './format';

const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm text-foreground';
const LIMIT_OPTIONS = [10, 20, 50].filter((n) => n <= KNOWLEDGE_SEARCH_MAX_LIMIT);

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function KnowledgeSearchExplorer({
  projectId,
  configured,
  canEdit,
}: {
  projectId: string;
  configured: boolean;
  canEdit: boolean;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(KNOWLEDGE_SEARCH_DEFAULT_LIMIT);
  const [type, setType] = useState<KnowledgeSourceType | ''>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<KnowledgeSearchResponse | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeSourceDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = configured && query.trim().length > 0 && !loading;

  const runSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { query: query.trim(), limit };
      if (type) body.source_types = [type];
      setResponse(
        await api<KnowledgeSearchResponse>(`/projects/${projectId}/knowledge/search`, { method: 'POST', body }),
      );
    } catch (e2) {
      setError(message(e2));
      setResponse(null);
    } finally {
      setLoading(false);
    }
  };

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
  }, []);

  const openSource = useCallback(
    async (sourceId: string) => {
      setSelectedId(sourceId);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        setDetail(await api<KnowledgeSourceDetailDto>(`/projects/${projectId}/knowledge/sources/${sourceId}`));
      } catch (e) {
        setDetailError(message(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [projectId],
  );

  const reloadDetail = useCallback(
    async (sourceId: string) => {
      try {
        setDetail(await api<KnowledgeSourceDetailDto>(`/projects/${projectId}/knowledge/sources/${sourceId}`));
      } catch {
        // keep the current detail; the request already surfaced any error
      }
    },
    [projectId],
  );

  const runAction = useCallback(
    async (id: string, action: 'ingest' | 'reindex' | 'delete') => {
      setBusy(true);
      setDetailError(null);
      try {
        if (action === 'delete') {
          await api(`/projects/${projectId}/knowledge/sources/${id}`, { method: 'DELETE' });
          closeDetail();
          return;
        }
        await api(`/projects/${projectId}/knowledge/sources/${id}/${action}`, { method: 'POST', body: {} });
        setDetail(await api<KnowledgeSourceDetailDto>(`/projects/${projectId}/knowledge/sources/${id}`));
      } catch (e) {
        setDetailError(message(e));
      } finally {
        setBusy(false);
      }
    },
    [projectId, closeDetail],
  );

  const results = response?.results ?? [];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Search Explorer</CardTitle>
          <CardDescription>
            Direct retrieval over this project&apos;s knowledge base. Scores are retrieval/similarity scores from the
            ranking provider - a ranking signal, not evidence that the content is true. Results are untrusted reference
            text.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!configured && (
            <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
              Knowledge search is not usable on this server yet.
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <form className="flex flex-wrap items-center gap-2" onSubmit={runSearch}>
            <Input
              type="search"
              aria-label="Search query"
              placeholder="What do you want to find?"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={KNOWLEDGE_SEARCH_QUERY_MAX_CHARS}
              className="min-w-[220px] flex-1"
            />
            <select
              aria-label="Result limit"
              className={selectClass}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {LIMIT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} results
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by source type"
              className={selectClass}
              value={type}
              onChange={(e) => setType(e.target.value as KnowledgeSourceType | '')}
            >
              <option value="">All types</option>
              {KNOWLEDGE_SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SOURCE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <Button type="submit" disabled={!canSubmit}>
              {loading ? 'Searching…' : 'Search'}
            </Button>
          </form>

          {response && (
            <div className="grid gap-2" aria-label="Search results">
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>
                  {response.diagnostics.result_count}{' '}
                  {response.diagnostics.result_count === 1 ? 'result' : 'results'}
                </span>
                <span>·</span>
                <span>provider: {response.diagnostics.provider}</span>
                <span>·</span>
                <span>{response.diagnostics.search_duration_ms} ms</span>
              </div>

              {results.length === 0 ? (
                <Empty>No relevant knowledge found.</Empty>
              ) : (
                results.map((r, i) => (
                  <div key={`${r.source_id}:${r.chunk_index ?? i}`} className="rounded-lg border bg-muted/50 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{r.source_name}</span>
                        <Badge variant="outline">{SOURCE_TYPE_LABELS[r.source_type]}</Badge>
                        {r.chunk_index != null && (
                          <span className="text-[11px] text-muted-foreground">chunk {r.chunk_index + 1}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" title="Retrieval/similarity score from the ranking provider">
                          score {r.score.toFixed(3)}
                        </Badge>
                        {r.managed && (
                          <Button size="sm" variant="outline" onClick={() => void openSource(r.source_id)}>
                            Open source
                          </Button>
                        )}
                      </div>
                    </div>
                    {r.source_url && (
                      <div className="my-1 truncate font-mono text-xs text-muted-foreground">{r.source_url}</div>
                    )}
                    <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{r.content}</p>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {selectedId && (
        <KnowledgeSourceDetail
          projectId={projectId}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          canEdit={canEdit}
          busy={busy}
          onClose={closeDetail}
          onIngest={(id) => void runAction(id, 'ingest')}
          onReindex={(id) => void runAction(id, 'reindex')}
          onDelete={(id) => void runAction(id, 'delete')}
          onChanged={() => void reloadDetail(selectedId)}
        />
      )}
    </>
  );
}
