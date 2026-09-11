/**
 * Knowledge Base view (project nav "Knowledge").
 *
 * Semantic search over the content and data this project has collected, backed
 * by a per-project Qdrant collection - searches and indexing never cross
 * project boundaries (see CLAUDE.md). The view reports honestly whether the
 * embedding provider is configured, and indexing is a background job whose
 * progress and failures are visible below.
 */
import { useState } from 'react';
import { api } from '../lib/api';
import { useAsync, num, useJobs, JobTable, Empty } from '../lib/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';

interface Status {
  provider: { id: string; name: string; description: string } | null;
  configured: boolean;
  note: string;
}
interface Hit {
  id?: string;
  score?: number;
  payload?: Record<string, unknown>;
}

/**
 * Shows knowledge status, a semantic search box (only when configured) and the
 * project's indexing jobs. All reads go through project-scoped endpoints;
 * search posts the query to the API, never to Qdrant directly.
 */
export function Knowledge({ projectId }: { projectId: string }) {
  const [refresh, setRefresh] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = useAsync<Status>(() => api(`/projects/${projectId}/knowledge/status`), [projectId, refresh]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [enqueuing, setEnqueuing] = useState(false);
  const { jobs, busy } = useJobs(projectId, true);

  const search = async () => {
    setErr(null);
    setSearching(true);
    try {
      const r = await api<{ results: Hit[] }>(`/projects/${projectId}/knowledge/search`, {
        method: 'POST',
        body: { query: query.trim(), limit: 10 },
      });
      setResults(r.results);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const indexNow = async () => {
    setErr(null);
    setNotice(null);
    setEnqueuing(true);
    try {
      const r = await api<{ job: { id: string } }>(`/projects/${projectId}/jobs`, {
        method: 'POST',
        body: { job_type: 'knowledge_index', params: {} },
      });
      setNotice(`Index job queued (${r.job.id.slice(0, 8)}…). See jobs below for progress.`);
      setTimeout(() => setRefresh((x) => x + 1), 800);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnqueuing(false);
    }
  };

  const configured = status.data?.configured ?? false;

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Knowledge Base"
        description="Semantic search over the content and data this project has collected (Qdrant, per-project isolated collection)."
      />

      {err && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{notice}</div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {status.loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : status.data?.provider ? (
            <>
              <p className="flex flex-wrap items-center gap-2 text-sm">
                Provider: <b>{status.data.provider.name}</b>
                {configured ? (
                  <Badge variant="success">configured</Badge>
                ) : (
                  <Badge variant="destructive">not configured</Badge>
                )}
              </p>
              {!configured && (
                <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
                  Qdrant or the embedding key (EMBEDDINGS_API_KEY) is missing on the API server. Add them to run semantic
                  search and indexing.
                </div>
              )}
              <p className="text-sm text-muted-foreground">{status.data.note}</p>
              {configured && (
                <div>
                  <Button disabled={enqueuing} onClick={() => void indexNow()}>
                    {enqueuing ? 'Queuing…' : 'Rebuild index (background job)'}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <Empty>{status.data?.note ?? 'No knowledge provider.'}</Empty>
          )}
        </CardContent>
      </Card>

      {configured && (
        <Card>
          <CardHeader>
            <CardTitle>Search</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="What have we learned about…"
                className="min-w-[240px] flex-1"
              />
              <Button type="submit" disabled={searching || !query.trim()}>
                {searching ? 'Searching…' : 'Search'}
              </Button>
            </form>
            {results && (
              <div className="grid gap-2">
                {results.length === 0 && <Empty>No matches.</Empty>}
                {results.map((h, i) => {
                  const p = h.payload ?? {};
                  return (
                    <div key={String(h.id ?? i)} className="rounded-lg border bg-muted/50 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <span className="font-medium">{String(p.title ?? '(untitled)')}</span>
                        <Badge variant="outline">{h.score != null ? num(h.score).toFixed(3) : ''}</Badge>
                      </div>
                      <div className="my-1 font-mono text-xs text-muted-foreground">
                        {String(p.url ?? p.source ?? p.kind ?? '')}
                      </div>
                      <p className="text-sm text-muted-foreground">{String(p.text ?? p.excerpt ?? '').slice(0, 300)}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Indexing jobs {busy ? <Badge variant="warning">running…</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <JobTable jobs={jobs.filter((j) => j.job_type.startsWith('knowledge_'))} />
        </CardContent>
      </Card>
    </div>
  );
}
