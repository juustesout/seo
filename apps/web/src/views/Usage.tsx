/**
 * Usage view (R5.10.8).
 *
 * Minimal read-only report over the append-only usage ledger: aggregate
 * consumption grouped by category/provider/operation/unit with a total quantity
 * and event count. Deliberately no charts, pricing, budgets, invoices or cost -
 * the ledger stores facts, and cost is a future derivation from facts + pricing.
 *
 * One component serves both scopes: pass a `projectId` for the project's own
 * consumption (`GET /api/projects/:id/usage`), omit it for the caller's account
 * (`GET /api/account/usage`). Both endpoints return the same `UsageReportDto`.
 */
import type { UsageReportDto } from '@seo/contracts';
import { api } from '../lib/api';
import { useAsync, fmtNum, Empty } from '../lib/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function Usage({ projectId }: { projectId?: string }) {
  const path = projectId ? `/projects/${projectId}/usage` : '/account/usage';
  const { data, loading, error } = useAsync<UsageReportDto>(() => api<UsageReportDto>(path), [path]);
  const totals = data?.totals ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage"
        description={
          projectId
            ? 'Measured external consumption recorded for this project. Counts only - no pricing or cost.'
            : 'Measured external consumption recorded across this account. Counts only - no pricing or cost.'
        }
      />
      {loading ? (
        <Empty>Loading usage…</Empty>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : totals.length === 0 ? (
        <Empty>No usage recorded yet</Empty>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Consumption by operation</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {totals.map((row) => (
                  <TableRow key={`${row.category}|${row.provider}|${row.operation}|${row.unit}`}>
                    <TableCell>{row.category}</TableCell>
                    <TableCell>{row.provider}</TableCell>
                    <TableCell>{row.operation}</TableCell>
                    <TableCell>{row.unit}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(row.quantity)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(row.eventCount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
