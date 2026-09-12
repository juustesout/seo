/**
 * Knowledge Overview (KBUI1) - the operational landing page.
 *
 * Answers "what is in my knowledge base and is everything healthy?" from
 * existing read models only: the bounded source list response carries the
 * project health summary, the provider descriptor and the recent sources, and
 * a second bounded query lists failed sources. No metrics are invented - the
 * API's stored status is authoritative and links lead to the matching filtered
 * Sources view.
 */
import { useEffect, useState } from 'react';
import type { KnowledgeCollectionDto, KnowledgeSourcesResponse } from '@seo/contracts';
import { api } from '../../../lib/api';
import { useAsync, useJobs, JobTable, fmtDate, Empty } from '../../../lib/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SOURCE_STATUS_LABELS, SOURCE_TYPE_LABELS, statusBadgeVariant } from '../format';
import { AddSourceDialog, type AddSourceKind } from '../sources/AddSourceDialog';
import type { KnowledgeSection } from './KnowledgeNavigation';

function Kpi({
  value,
  label,
  onOpen,
}: {
  value: number;
  label: string;
  onOpen?: () => void;
}) {
  const inner = (
    <>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </>
  );
  if (!onOpen) {
    return <div className="rounded-lg border bg-muted/20 px-4 py-3">{inner}</div>;
  }
  return (
    <button type="button" onClick={onOpen} className="rounded-lg border bg-muted/20 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40">
      {inner}
    </button>
  );
}

export function KnowledgeOverview({
  projectId,
  canEdit,
  collections = [],
  onNavigate,
}: {
  projectId: string;
  canEdit: boolean;
  collections?: KnowledgeCollectionDto[];
  onNavigate: (section: KnowledgeSection, params?: Record<string, string | null>) => void;
}) {
  const [tick, setTick] = useState(0);
  const recent = useAsync<KnowledgeSourcesResponse>(
    () => api(`/projects/${projectId}/knowledge/sources?limit=5&sort=updated_desc`),
    [projectId, tick],
  );
  const failed = useAsync<KnowledgeSourcesResponse>(
    () => api(`/projects/${projectId}/knowledge/sources?status=failed&limit=5`),
    [projectId, tick],
  );

  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<AddSourceKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [enqueuing, setEnqueuing] = useState(false);
  const { jobs, busy: jobsBusy } = useJobs(projectId, true);

  const summary = recent.data?.summary ?? null;
  const processing = (summary?.queued ?? 0) + (summary?.processing ?? 0);

  // Keep the dashboard honest while background work is in flight.
  useEffect(() => {
    if (processing <= 0) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => window.clearInterval(id);
  }, [processing]);

  const openAdd = (kind: AddSourceKind) => {
    setAddKind(kind);
    setAddOpen(true);
  };

  const indexNow = async () => {
    setActionError(null);
    setNotice(null);
    setEnqueuing(true);
    try {
      const r = await api<{ job: { id: string } }>(`/projects/${projectId}/jobs`, {
        method: 'POST',
        body: { job_type: 'knowledge_index', params: {} },
      });
      setNotice(`Index job queued (${r.job.id.slice(0, 8)}…).`);
      setTick((t) => t + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnqueuing(false);
    }
  };

  const configured = recent.data?.configured ?? false;
  const provider = recent.data?.provider ?? null;
  const recentItems = recent.data?.items ?? [];
  const failedItems = failed.data?.items ?? [];
  const empty = summary !== null && summary.total === 0;
  const error = recent.error;

  return (
    <div className="grid gap-5">
      {(error || actionError) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{error ?? actionError}</span>
          <Button size="sm" variant="outline" onClick={() => setTick((t) => t + 1)}>
            Try again
          </Button>
        </div>
      )}
      {notice && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
          <span>{notice}</span>
          <Button size="sm" variant="outline" onClick={() => onNavigate('sources')}>
            View sources
          </Button>
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => openAdd('text')}>
            Add text
          </Button>
          <Button size="sm" variant="outline" onClick={() => openAdd('url')}>
            Add URL
          </Button>
          <Button size="sm" variant="outline" onClick={() => openAdd('file')}>
            Upload file
          </Button>
          <Button size="sm" variant="outline" onClick={() => onNavigate('discover')}>
            Discover website
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi value={summary?.total ?? 0} label="Total sources" onOpen={() => onNavigate('sources')} />
        <Kpi value={summary?.ready ?? 0} label="Ready" onOpen={() => onNavigate('sources', { status: 'ready' })} />
        <Kpi value={processing} label="Processing" onOpen={() => onNavigate('sources', { status: 'processing' })} />
        <Kpi value={summary?.failed ?? 0} label="Failed" onOpen={() => onNavigate('sources', { status: 'failed' })} />
      </div>

      {empty ? (
        <Card>
          <CardContent className="grid gap-2 py-6 text-center">
            <div className="text-sm font-medium">Your knowledge base is empty</div>
            <p className="text-sm text-muted-foreground">
              Add text, upload a document or connect a website to start building project knowledge.
            </p>
            {canEdit && (
              <div className="mt-1 flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => openAdd('text')}>
                  Add source
                </Button>
                <Button size="sm" variant="outline" onClick={() => onNavigate('discover')}>
                  Discover website
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => onNavigate('sources', { status: 'ready' })}
              className="rounded-lg border bg-muted/20 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <div className="text-sm font-medium">Healthy</div>
              <div className="text-xs text-muted-foreground">{summary?.ready ?? 0} ready sources</div>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('sources', { status: 'failed' })}
              className="rounded-lg border bg-muted/20 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <div className="text-sm font-medium">Needs attention</div>
              <div className="text-xs text-muted-foreground">{summary?.failed ?? 0} failed sources</div>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('sources', { status: 'processing' })}
              className="rounded-lg border bg-muted/20 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <div className="text-sm font-medium">Processing</div>
              <div className="text-xs text-muted-foreground">{processing} in progress</div>
            </button>
          </div>

          {failedItems.length > 0 && (
            <Card>
              <CardContent className="grid gap-1.5 py-4">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Needs attention</div>
                {failedItems.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onNavigate('sources', { source: s.id })}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-2 text-left"
                  >
                    <span className="truncate text-sm">{s.name}</span>
                    <Badge variant="destructive">{SOURCE_STATUS_LABELS[s.status]}</Badge>
                  </button>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="grid gap-1.5 py-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent sources</div>
              {recentItems.length === 0 ? (
                <Empty>No sources yet.</Empty>
              ) : (
                recentItems.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onNavigate('sources', { source: s.id })}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-2 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{s.name}</span>
                      <span className="block text-xs text-muted-foreground">Updated {fmtDate(s.updated_at)}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Badge variant="outline">{SOURCE_TYPE_LABELS[s.source_type]}</Badge>
                      <Badge variant={statusBadgeVariant(s.status)}>{SOURCE_STATUS_LABELS[s.status]}</Badge>
                    </span>
                  </button>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
        <span className="text-muted-foreground">Knowledge Index</span>
        <b>{provider?.name ?? 'No provider'}</b>
        {configured ? <Badge variant="success">Configured</Badge> : <Badge variant="destructive">Not configured</Badge>}
        {!configured && recent.data?.note && <span className="text-xs text-muted-foreground">{recent.data.note}</span>}
      </div>

      {canEdit && (
        <details className="rounded-lg border bg-muted/20">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Indexing{jobsBusy ? ' · running…' : ''}
          </summary>
          <div className="grid gap-3 px-3 pb-3">
            <div>
              <Button size="sm" variant="outline" disabled={enqueuing || !configured} onClick={() => void indexNow()}>
                {enqueuing ? 'Queuing…' : 'Rebuild index'}
              </Button>
            </div>
            <JobTable jobs={jobs.filter((j) => String(j.job_type).startsWith('knowledge_'))} />
          </div>
        </details>
      )}

      <AddSourceDialog
        projectId={projectId}
        open={addOpen}
        initialKind={addKind}
        collections={collections}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setNotice('Source added. Indexing is queued in the background.');
          setTick((t) => t + 1);
        }}
      />
    </div>
  );
}
