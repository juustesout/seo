/**
 * Platform admin - users (P3).
 *
 * Identity plus account association and reach. Read-only by design: no
 * impersonation, no role editing, no auth-provider controls.
 */
import { useAsync, fmtDate, fmtNum, Empty } from '../../lib/ui';
import { adminUsers } from '../../lib/admin';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function AdminUsers() {
  const { data, loading, error } = useAsync(() => adminUsers(), []);

  return (
    <div className="space-y-6">
      <PageHeader title="Users" description="All users known to the platform, with account association and project reach." />
      {loading ? (
        <Empty>Loading users…</Empty>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !data || data.length === 0 ? (
        <Empty>No users</Empty>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>User ID</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Projects</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((user) => (
                  <TableRow key={user.user_id}>
                    <TableCell>{user.email ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{user.user_id}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{user.account_id ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(user.project_count)}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(user.created_at)}</TableCell>
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
