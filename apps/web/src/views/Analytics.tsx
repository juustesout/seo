/**
 * Page-traffic view (P4, project nav "Analytics").
 *
 * A compact read of "which pages actually receive traffic?" from the project's
 * bound GA4 property. It is deliberately not a Google Analytics replacement:
 * one table, one period, honest states (not connected / no property / no
 * traffic / error). All Google specifics stay server-side; this view only
 * renders the normalized report.
 */
import { useState } from 'react';
import { num, useAsync } from '../lib/ui';
import { pageTraffic, type AnalyticsPageTrafficReport } from '../lib/analytics';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { DEFAULT_PERIOD_DAYS, PeriodSelector, periodLabel } from '@/components/ui/period-selector';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** Large, readable integer (12000 -> "12,000"). */
function fmtCount(v: unknown): string {
  return num(v).toLocaleString();
}

export function Analytics({ projectId, onOpenSettings }: { projectId: string; onOpenSettings?: () => void }) {
  const [days, setDays] = useState(DEFAULT_PERIOD_DAYS);
  const report = useAsync<AnalyticsPageTrafficReport>(() => pageTraffic(projectId, days), [projectId, days]);

  const data = report.data;

  return (
    <div className="grid gap-5">
      <PageHeader title="Page traffic" description="Which pages actually receive traffic, from Google Analytics 4." />

      <PeriodSelector value={days} onChange={setDays} />

      <Card>
        <CardHeader>
          <CardTitle>
            {data?.property ? data.property.property_name : 'Page traffic'}
            {data?.property?.property_url && <span className="ml-2 text-sm font-normal text-muted-foreground">{data.property.property_url}</span>}
          </CardTitle>
          {data && <p className="text-sm text-muted-foreground">{periodLabel(data.period.days)}</p>}
        </CardHeader>
        <CardContent>
          {report.loading ? (
            <p className="text-sm text-muted-foreground">Loading page traffic…</p>
          ) : report.error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{report.error}</div>
          ) : !data?.property ? (
            <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">Choose a Google Analytics property for this project.</p>
              {onOpenSettings && (
                <div>
                  <Button size="sm" variant="outline" onClick={onOpenSettings}>
                    Open project settings
                  </Button>
                </div>
              )}
            </div>
          ) : data.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No page traffic was recorded for this period.</p>
          ) : (
            <div className="grid gap-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Page</TableHead>
                    <TableHead className="text-right">Views</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead className="text-right">Sessions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.path}>
                      <TableCell className="font-mono text-xs">{r.path}</TableCell>
                      <TableCell className="text-right text-base font-semibold tabular-nums">{fmtCount(r.views)}</TableCell>
                      <TableCell className="text-right text-base font-semibold tabular-nums">{fmtCount(r.active_users)}</TableCell>
                      <TableCell className="text-right text-base font-semibold tabular-nums">{fmtCount(r.sessions)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data.truncated && (
                <p className="text-xs text-muted-foreground">Showing the top {fmtCount(data.limit)} pages by views.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
