/**
 * Platform admin - usage (P3).
 *
 * Cross-account aggregate of the append-only usage ledger. Counts only: the
 * ledger stores facts and no pricing/cost is modeled, so none is shown.
 */
import { useAsync, fmtNum, Empty } from '../../lib/ui';
import { adminUsage } from '../../lib/admin';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function AdminUsage() {
  const { data, loading, error } = useAsync(() => adminUsage(), []);
  const totals = data?.totals ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage"
        description="Recorded external consumption across all accounts. Counts only - no pricing or cost."
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
