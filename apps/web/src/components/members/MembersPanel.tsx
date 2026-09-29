/**
 * Project member administration panel (P2, Phase B).
 *
 * Renders the current members of a project with their role and lets an
 * owner/admin add a member, change a role and remove a member. The database
 * RPCs are the authorization boundary: this component only decides what to
 * *show*. A viewer/editor never mounts the panel, and the server still refuses
 * the RPCs with `42501` if reached another way. Owner protection (a project
 * must keep at least one owner) is enforced by the server; the UI mirrors it by
 * disabling the actions that would remove or demote the last owner.
 */
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useAsync, fmtDate } from '../../lib/ui';
import {
  MEMBER_ROLES,
  addProjectMember,
  listProjectMembers,
  removeProjectMember,
  updateProjectMemberRole,
  type MemberRole,
  type ProjectMember,
} from '../../lib/members';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const SELECT_CLASS =
  'flex h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

function label(m: ProjectMember): string {
  return m.email ?? m.user_id;
}

export function MembersPanel({ projectId, role }: { projectId: string; role: string }) {
  const canManage = role === 'owner' || role === 'admin';
  if (!canManage) return null;
  return <MembersPanelInner projectId={projectId} canManageOwners={role === 'owner'} />;
}

function MembersPanelInner({ projectId, canManageOwners }: { projectId: string; canManageOwners: boolean }) {
  const members = useAsync<ProjectMember[]>(() => listProjectMembers(projectId), [projectId]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<MemberRole>('editor');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const rows = members.data ?? [];
  const ownerCount = rows.filter((m) => m.role === 'owner').length;
  const grantableRoles: MemberRole[] = canManageOwners ? MEMBER_ROLES : ['editor', 'viewer'];

  const run = async (key: string, fn: () => Promise<unknown>, success: string): Promise<boolean> => {
    setBusy(key);
    setErr(null);
    setOk(null);
    try {
      await fn();
      setOk(success);
      members.reload();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const invite = async () => {
    const email = inviteEmail.trim();
    if (!email) {
      setErr('Enter the email of an existing user to add.');
      return;
    }
    const done = await run('invite', () => addProjectMember(projectId, email, inviteRole), 'Member added.');
    if (done) setInviteEmail('');
  };

  const remove = (m: ProjectMember) => {
    if (!window.confirm(`Remove ${label(m)} from this project?`)) return;
    void run(`remove:${m.user_id}`, () => removeProjectMember(projectId, m.user_id), 'Member removed.');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <p className="text-sm text-muted-foreground">
          People who can access this project. Roles are owner, admin, editor and viewer; a project always keeps at least
          one owner.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        {err && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {err}
          </div>
        )}
        {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>}

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void invite();
          }}
        >
          <div className="grid gap-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="member-invite-email">
              Add by email
            </label>
            <Input
              id="member-invite-email"
              type="email"
              placeholder="user@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              disabled={busy !== null}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="member-invite-role">
              Role
            </label>
            <select
              id="member-invite-role"
              className={SELECT_CLASS}
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as MemberRole)}
              disabled={busy !== null}
            >
              {grantableRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={busy !== null}>
            {busy === 'invite' ? 'Adding…' : 'Add member'}
          </Button>
        </form>

        {members.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {members.error}
          </div>
        )}
        {!members.data && members.loading && <p className="text-sm text-muted-foreground">Loading members…</p>}

        {members.data && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Added</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No members yet.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((m) => {
                const lastOwner = m.role === 'owner' && ownerCount <= 1;
                const canRemove = canManageOwners || m.role !== 'owner';
                return (
                  <TableRow key={m.user_id}>
                    <TableCell>{label(m)}</TableCell>
                    <TableCell>
                      {canManageOwners ? (
                        <select
                          aria-label={`Role for ${label(m)}`}
                          className={cn(SELECT_CLASS, 'h-8')}
                          value={m.role}
                          disabled={busy !== null || lastOwner}
                          onChange={(e) => {
                            const next = e.target.value as MemberRole;
                            void run(
                              `role:${m.user_id}`,
                              () => updateProjectMemberRole(projectId, m.user_id, next),
                              'Role updated.',
                            );
                          }}
                        >
                          {MEMBER_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge variant="secondary">{m.role}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(m.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Remove ${label(m)}`}
                        disabled={busy !== null || lastOwner || !canRemove}
                        onClick={() => remove(m)}
                      >
                        {busy === `remove:${m.user_id}` ? 'Removing…' : 'Remove'}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
