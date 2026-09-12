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
import { useAsync, useJobs, JobTable, Empty } from '../lib/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { KnowledgeLibrary } from '../components/knowledge/KnowledgeLibrary';
import { KnowledgeSearchExplorer } from '../components/knowledge/KnowledgeSearchExplorer';

interface Status {
  provider: { id: string; name: string; description: string } | null;
  configured: boolean;
  note: string;
}

/** Editor-or-higher roles can manage sources; viewers get read-only surfaces. */
const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

type Tab = 'library' | 'search';

/**
 * Shows the source library (summary, filters, metadata search, detail and
 * lifecycle actions), the retrieval Search Explorer, the knowledge status and
 * the project's indexing jobs. All reads go through project-scoped endpoints;
 * search posts the query to the API, never to Qdrant directly.
 */
export function Knowledge({ projectId, role = 'viewer' }: { projectId: string; role?: string }) {
  const canEdit = (ROLE_RANK[role] ?? 0) >= 1;
  const [tab, setTab] = useState<Tab>('library');
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = useAsync<Status>(() => api(`/projects/${projectId}/knowledge/status`), [projectId]);
  const [enqueuing, setEnqueuing] = useState(false);
  const { jobs, busy } = useJobs(projectId, true);

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
        title="Knowledge Library"
        description="Manage the project's reference sources, review what has been indexed and search the project-isolated vector base."
      />

      {err && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{notice}</div>
      )}

      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Knowledge sections">
        <Button
          role="tab"
          aria-selected={tab === 'library'}
          variant={tab === 'library' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setTab('library')}
        >
          Library
        </Button>
        <Button
          role="tab"
          aria-selected={tab === 'search'}
          variant={tab === 'search' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setTab('search')}
        >
          Search
        </Button>
      </div>

      {tab === 'library' ? (
        <KnowledgeLibrary projectId={projectId} canEdit={canEdit} />
      ) : (
        <KnowledgeSearchExplorer projectId={projectId} configured={configured} canEdit={canEdit} />
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
