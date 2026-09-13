/**
 * Knowledge Overview (KBUI1, rebuilt as an Operations Dashboard in KBUI3).
 *
 * Answers "what is happening in my whole knowledge base, what needs attention
 * and what should I do today?" from existing read models only: the bounded
 * source list response carries the project health summary, and a handful of
 * bounded, filtered queries surface the attention queue, active processing,
 * recent activity and collection organization. No metric, progress or activity
 * is invented - every value maps to a stored status/timestamp and every link is
 * a real filtered Sources view or source deep link.
 *
 * The dashboard composes small presentational sections (Health, AttentionQueue,
 * ProcessingSummary, RecentActivity, CollectionsSummary); it owns the reads so
 * no card fetches its own data, and it only polls while work is actually in
 * flight.
 */
import { useEffect, useState } from 'react';
import type { KnowledgeCollectionDto, KnowledgeSourcesResponse } from '@seo/contracts';
import { api } from '../../../lib/api';
import { useAsync, useJobs, JobTable } from '../../../lib/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AddSourceDialog, type AddSourceKind } from '../sources/AddSourceDialog';
import type { KnowledgeSection } from '../workspace/KnowledgeNavigation';
import { KnowledgeHealth } from './KnowledgeHealth';
import { AttentionQueue } from './AttentionQueue';
import { ProcessingSummary } from './ProcessingSummary';
import { RecentActivity } from './RecentActivity';
import { CollectionsSummary } from './CollectionsSummary';

const ATTENTION_LIMIT = 4;

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
  const list = (qs: string) => api<KnowledgeSourcesResponse>(`/projects/${projectId}/knowledge/sources?${qs}`);
  const recent = useAsync(() => list('limit=6&sort=updated_desc'), [projectId, tick]);
  const failed = useAsync(() => list('status=failed&limit=4'), [projectId, tick]);
  const due = useAsync(() => list('freshness=due&limit=4'), [projectId, tick]);
  const stale = useAsync(() => list('freshness=stale&limit=4'), [projectId, tick]);
  const processing = useAsync(() => list('status=processing&limit=4'), [projectId, tick]);

  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<AddSourceKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [enqueuing, setEnqueuing] = useState(false);
  const { jobs, busy: jobsBusy } = useJobs(projectId, true);

  const summary = recent.data?.summary ?? null;
  const processingCount = (summary?.queued ?? 0) + (summary?.processing ?? 0);
  const failedItems = failed.data?.items ?? [];
  const dueItems = due.data?.items ?? [];
  const staleItems = stale.data?.items ?? [];
  const attentionCount = failedItems.length + dueItems.length + staleItems.length;
  const configured = recent.data?.configured ?? false;
  const provider = recent.data?.provider ?? null;
  const empty = summary !== null && summary.total === 0;
  const error = recent.error;

  // Keep the dashboard honest while background work is in flight.
  useEffect(() => {
    if (processingCount <= 0) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => window.clearInterval(id);
  }, [processingCount]);

  const openAdd = (kind: AddSourceKind | null) => {
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

  const go = (params: Record<string, string>) => onNavigate('sources', params);
  const openSource = (id: string) => onNavigate('sources', { source: id });

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
          <Button size="sm" onClick={() => openAdd(null)}>
            Add source
          </Button>
          <Button size="sm" variant="outline" onClick={() => onNavigate('discover')}>
            Discover website
          </Button>
        </div>
      )}

      {empty ? (
        <Card>
          <CardContent className="grid gap-2 py-6 text-center">
            <div className="text-sm font-medium">Your knowledge base is empty</div>
            <p className="text-sm text-muted-foreground">
              Add text, upload a document or connect a website to start building project knowledge.
            </p>
            {canEdit && (
              <div className="mt-1 flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => openAdd(null)}>
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
        summary && (
          <>
            <KnowledgeHealth summary={summary} processing={processingCount} onOpen={go} />

            {attentionCount === 0 && processingCount === 0 ? (
              <div className="rounded-lg border border-success/30 bg-success/5 px-4 py-3" aria-label="Healthy">
                <div className="text-sm font-medium text-success">Everything looks healthy.</div>
                <p className="text-xs text-muted-foreground">All available sources are ready.</p>
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                <AttentionQueue
                  failed={failedItems}
                  due={dueItems}
                  stale={staleItems}
                  onOpenSource={openSource}
                  onReview={go}
                />
                <ProcessingSummary count={processingCount} items={processing.data?.items ?? []} onView={() => go({ status: 'processing' })} />
              </div>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
              <RecentActivity items={recent.data?.items ?? []} onOpenSource={openSource} />
              <CollectionsSummary
                collections={collections}
                totalSources={summary.total}
                onOpenCollection={(id) => go({ collection: id })}
                onOpenUncategorized={() => go({ uncategorized: 'true' })}
                onManage={() => onNavigate('sources')}
              />
            </div>
          </>
        )
      )}

      <button
        type="button"
        onClick={() => onNavigate('search')}
        className="flex items-center justify-between gap-2 rounded-lg border bg-muted/20 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
      >
        <span className="text-sm">Search your knowledge base</span>
        <span className="text-xs text-muted-foreground">Search knowledge…</span>
      </button>

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
            <div className="flex flex-wrap gap-2">
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
