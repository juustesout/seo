/**
 * Content performance view (P7 measurement loop).
 *
 * The closing half of the loop: for every published content item, what did
 * Google actually do with it? Search Console clicks/impressions and stored GA4
 * page traffic are joined onto the live published URL. It is deliberately not an
 * automated SEO console - it shows real measured outcomes, labels items with no
 * matched data honestly, and never presents a missing provider as a zero.
 */
import { useState } from 'react';
import { fmtDate, fmtNum, useAsync } from '../lib/ui';
import {
  contentPerformance,
  syncContentPerformance,
  type ContentPerformanceReport,
} from '../lib/performance';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { DEFAULT_PERIOD_DAYS, PeriodSelector, periodLabel } from '@/components/ui/period-selector';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** A precise 1-decimal position, or an em dash when there is no data. */
function fmtPosition(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '—';
}

/** A percentage from a 0..1 ratio. */
function fmtCtr(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—';
}

export function Performance({
  projectId,
  role,
  onOpenGoogle,
}: {
  projectId: string;
  role: string;
  onOpenGoogle?: () => void;
}) {
  const [days, setDays] = useState(DEFAULT_PERIOD_DAYS);
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const report = useAsync<ContentPerformanceReport>(
    () => contentPerformance(projectId, days),
    [projectId, days, refreshKey],
  );
  const data = report.data;
  const canSync = role !== 'viewer';

  async function onSync() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await syncContentPerformance(projectId, days);
      const started = result.jobs.length;
      const parts: string[] = [];
      if (started > 0) parts.push(`${started} sync ${started === 1 ? 'job' : 'jobs'} started`);
      for (const s of result.skipped) parts.push(s.reason);
      setSyncMessage(parts.length > 0 ? parts.join('. ') : 'Nothing to sync.');
      if (started > 0) window.setTimeout(() => setRefreshKey((k) => k + 1), 2500);
    } catch {
      setSyncMessage('Could not start the sync. Please try again.');
    } finally {
      setSyncing(false);
    }
  }

  const totals = data?.totals;

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Content performance"
        description="How published content performs in Google Search and Google Analytics."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodSelector value={days} onChange={setDays} />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setRefreshKey((k) => k + 1)}>
            Refresh
          </Button>
          {canSync && (
            <Button size="sm" onClick={() => void onSync()} disabled={syncing}>
              {syncing ? 'Starting sync…' : 'Sync data'}
            </Button>
          )}
        </div>
      </div>

      {syncMessage && <p className="text-sm text-muted-foreground">{syncMessage}</p>}

      {data && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-normal text-muted-foreground">Search (Search Console)</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-6">
              <Stat label="Clicks" value={totals?.search ? fmtNum(totals.search.clicks) : '—'} />
              <Stat label="Impressions" value={totals?.search ? fmtNum(totals.search.impressions) : '—'} />
              <Stat label="CTR" value={totals?.search ? fmtCtr(totals.search.ctr) : '—'} />
              <Stat label="Avg. position" value={fmtPosition(totals?.search?.position)} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-normal text-muted-foreground">Traffic (Google Analytics)</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-6">
              <Stat label="Views" value={totals?.traffic ? fmtNum(totals.traffic.views) : '—'} />
              <Stat label="Users" value={totals?.traffic ? fmtNum(totals.traffic.active_users) : '—'} />
              <Stat label="Sessions" value={totals?.traffic ? fmtNum(totals.traffic.sessions) : '—'} />
            </CardContent>
          </Card>
        </div>
      )}

      {data && data.notes.length > 0 && (
        <div className="grid gap-1">
          {data.notes.map((note) => (
            <p key={note} className="text-sm text-muted-foreground">
              {note}
              {onOpenGoogle && (
                <button type="button" className="ml-2 underline" onClick={onOpenGoogle}>
                  Open Google
                </button>
              )}
            </p>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Published content</CardTitle>
          {data && (
            <p className="text-sm text-muted-foreground">
              {periodLabel(data.period.days)}
              {data.last_synced_at ? ` · last synced ${fmtDate(data.last_synced_at)}` : ''}
            </p>
          )}
        </CardHeader>
        <CardContent>
          {report.loading ? (
            <p className="text-sm text-muted-foreground">Loading content performance…</p>
          ) : report.error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {report.error}
            </div>
          ) : !data || data.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No published content yet. Publish an article to start measuring the loop.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Content</TableHead>
                  <TableHead>Live</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">Impressions</TableHead>
                  <TableHead className="text-right">Position</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                  <TableHead className="text-right">Users</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.content_id}>
                    <TableCell>
                      <div className="font-medium">{row.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.target_keyword ?? row.publication_url ?? '—'}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {row.days_live === null ? '—' : `${row.days_live}d`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.search ? fmtNum(row.search.clicks) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.search ? fmtNum(row.search.impressions) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.search ? fmtPosition(row.search.position) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.traffic ? fmtNum(row.traffic.views) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.traffic ? fmtNum(row.traffic.active_users) : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.state === 'measured' ? 'success' : 'outline'}>
                        {row.state === 'measured' ? 'Measured' : 'No data'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
