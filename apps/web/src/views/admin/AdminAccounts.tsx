/**
 * Platform admin - accounts (P3).
 *
 * One row per account with owner and reach. Read-only; no billing, plan or
 * subscription concepts exist in the product.
 */
import { useAsync, fmtDate, fmtNum, Empty } from '../../lib/ui';
import { adminAccounts } from '../../lib/admin';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function AdminAccounts() {
  const { data, loading, error } = useAsync(() => adminAccounts(), []);

  return (
    <div className="space-y-6">
      <PageHeader title="Accounts" description="All accounts with their owner and reach. No billing or plan data is modeled." />
      {loading ? (
        <Empty>Loading accounts…</Empty>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !data || data.length === 0 ? (
        <Empty>No accounts</Empty>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Account ID</TableHead>
                  <TableHead className="text-right">Projects</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((account) => (
                  <TableRow key={account.account_id}>
                    <TableCell>{account.name}</TableCell>
                    <TableCell>{account.owner_email ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{account.account_id}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(account.project_count)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(account.member_count)}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(account.created_at)}</TableCell>
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
