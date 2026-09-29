/**
 * Platform admin - operational overview (P3).
 *
 * Compact real-data summary: entity counts, job health and the current UTC
 * month's recorded usage-event count, plus the most recent jobs. Every number
 * comes from the API; no metric is invented (there is deliberately no "active
 * user" figure).
 */
import { useAsync, fmtNum, fmtDate, StatusPill, Empty } from '../../lib/ui';
import { adminOverview } from '../../lib/admin';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

export function AdminOverview() {
  const { data, loading, error } = useAsync(() => adminOverview(), []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform overview"
        description="Operational counts across all accounts. Read-only and derived from existing data."
      />
      {loading ? (
        <Empty>Loading overview…</Empty>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Metric label="Users" value={fmtNum(data.users)} />
            <Metric label="Accounts" value={fmtNum(data.accounts)} />
            <Metric label="Projects" value={fmtNum(data.projects)} />
            <Metric label="Jobs" value={fmtNum(data.jobs)} />
            <Metric label="Active jobs" value={fmtNum(data.active_jobs)} />
            <Metric label="Failed jobs" value={fmtNum(data.failed_jobs)} />
            <Metric label="Usage events (this month)" value={fmtNum(data.usage_events_this_period)} />
            <Metric label="Period start (UTC)" value={fmtDate(data.usage_period_start)} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent jobs</CardTitle>
            </CardHeader>
            <CardContent>
              {data.recent_jobs.length === 0 ? (
                <Empty>No jobs recorded yet</Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Project</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Queued</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recent_jobs.map((job) => (
                      <TableRow key={job.job_id}>
                        <TableCell>{job.project_name ?? job.project_id}</TableCell>
                        <TableCell>{job.provider}</TableCell>
                        <TableCell>{job.job_type}</TableCell>
                        <TableCell>
                          <StatusPill status={job.status} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{fmtDate(job.queued_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
