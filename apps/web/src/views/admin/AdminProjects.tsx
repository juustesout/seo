/**
 * Platform admin - projects (P3).
 *
 * Every project with its owning account, creator and member count. Read-only:
 * no project lifecycle or destructive controls.
 */
import { useAsync, fmtDate, fmtNum, Empty } from '../../lib/ui';
import { adminProjects } from '../../lib/admin';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function AdminProjects() {
  const { data, loading, error } = useAsync(() => adminProjects(), []);

  return (
    <div className="space-y-6">
      <PageHeader title="Projects" description="All projects across accounts. Read-only; projects have no modeled status." />
      {loading ? (
        <Empty>Loading projects…</Empty>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !data || data.length === 0 ? (
        <Empty>No projects</Empty>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Project ID</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((project) => (
                  <TableRow key={project.project_id}>
                    <TableCell>{project.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{project.project_id}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{project.account_id ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(project.member_count)}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(project.created_at)}</TableCell>
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
