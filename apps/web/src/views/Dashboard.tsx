/**
 * Project dashboard (default project view at `/p/:id/dashboard`).
 *
 * Aggregates real provider data - Search Console clicks/impressions, tracked
 * keywords, pages, ranking rows - and is honest about configuration: the
 * "active capabilities" list only shows capabilities that are actually on, the
 * feature pills come from the server payload (no invented metrics), and a CTA
 * appears when no GSC property is attached yet. Background jobs are listed and
 * polled while busy via lib/ui useJobs.
 */
import { api } from '../lib/api';
import { useAsync, fmtNum, fmtDate, useJobs, JobTable, Empty } from '../lib/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Dash {
  performance: { last_7d: number; last_28d: number; impressions_28d: number; days: number };
  counts: { keywords: number; pages: number; ranking_rows_28d: number };
  top_queries: Array<{ query: string; clicks: number; impressions: number; position: number }>;
  sources: { integrations: any[]; data_sources: any[]; last_sync_at: string | null };
  features: Record<string, boolean>;
}

interface GscState {
  google: { connected: boolean; status: string | null };
  current: { property_id: string; site_url: string } | null;
}

/** Dashboard CTA when this project has no GSC property attached yet. */
function GscAttachCta({ projectId, onOpenSettings }: { projectId: string; onOpenSettings: () => void }) {
  const { data } = useAsync<GscState>(() => api(`/projects/${projectId}/gsc/state`), [projectId]);
  if (!data || data.current) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-accent px-4 py-3 text-sm text-accent-foreground">
      <span>
        {data.google.connected
          ? 'This project has no Google Search Console property connected.'
          : 'This project is not connected to Google Search Console yet.'}
      </span>
      <Button size="sm" onClick={onOpenSettings}>
        {data.google.connected ? 'Attach GSC Property' : 'Set up Search Console'}
      </Button>
    </div>
  );
}

/**
 * Renders the dashboard payload from `/projects/:projectId/dashboard`.
 * `onOpenSettings` deep-links the "attach GSC property / set up Search
 * Console" CTA into the project's Settings view.
 */
export function Dashboard({ projectId, onOpenSettings }: { projectId: string; onOpenSettings: () => void }) {
  const { data, error, loading, reload } = useAsync<Dash>(
    () => api(`/projects/${projectId}/dashboard`),
    [projectId],
  );
  const { jobs, busy } = useJobs(projectId, Boolean(data));

  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const perf = data.performance;
  const feats = Object.entries(data.features)
    .filter(([, on]) => on)
    .map(([k]) => k);

  const stats = [
    { label: 'Clicks (7d)', value: fmtNum(perf.last_7d) },
    { label: 'Clicks (28d)', value: fmtNum(perf.last_28d) },
    { label: 'Impressions (28d)', value: fmtNum(perf.impressions_28d) },
    { label: 'Tracked keywords', value: fmtNum(data.counts.keywords) },
    { label: 'Pages', value: fmtNum(data.counts.pages) },
    { label: 'Ranking rows (28d)', value: fmtNum(data.counts.ranking_rows_28d) },
  ];

  return (
    <div className="grid gap-5">
      <div className="grid gap-3">
        <PageHeader
          title="Dashboard"
          description={
            <>
              Last sync {data.sources.last_sync_at ? fmtDate(data.sources.last_sync_at) : 'never'} ·{' '}
              {data.sources.integrations.length} integrations · {data.sources.data_sources.length} data source(s)
            </>
          }
        />
        <GscAttachCta projectId={projectId} onOpenSettings={onOpenSettings} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {stats.map((s) => (
          <Card key={s.label} className="gap-0 py-4">
            <CardContent className="px-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Active capabilities</CardTitle>
          </CardHeader>
          <CardContent>
            {feats.length === 0 ? (
              <Empty>
                No data sources connected yet. Open <b>Integrations</b> to connect Search Console or DataForSEO.
              </Empty>
            ) : (
              <div className="flex flex-wrap gap-2">
                {feats.map((f) => (
                  <Badge key={f} variant="success">
                    {f}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top queries (28d)</CardTitle>
          </CardHeader>
          <CardContent>
            {data.top_queries.length === 0 ? (
              <Empty>No search query data yet</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Query</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">Impr.</TableHead>
                    <TableHead className="text-right">Pos</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.top_queries.map((q) => (
                    <TableRow key={q.query}>
                      <TableCell>{q.query}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(q.clicks)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(q.impressions)}</TableCell>
                      <TableCell className="text-right tabular-nums">{q.position ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            Background jobs {busy ? <Badge variant="warning">running…</Badge> : null}
          </CardTitle>
          <Button variant="outline" size="sm" onClick={reload}>
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          <JobTable jobs={jobs} />
        </CardContent>
      </Card>
    </div>
  );
}
