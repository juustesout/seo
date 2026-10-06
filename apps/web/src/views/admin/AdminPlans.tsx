/**
 * Platform admin - plans & effective policy (P14).
 *
 * Read-only view of the product policy an account resolves to: the configured
 * plans and, for a chosen account, the effective resource allowances with
 * this-period consumption, remaining and funding behaviour. This is the same
 * read model the account owner sees, re-verified against the platform-admin
 * registry server-side. It is policy visibility, never billing: there are no
 * prices, invoices or credits.
 */
import { useState } from 'react';
import { ENTITLEMENT_RESOURCE_SPEC, isValidEntitlementResource } from '@seo/contracts';
import type { AccountEntitlementDto } from '@seo/contracts';
import { useAsync, fmtNum, fmtDate, Empty } from '../../lib/ui';
import { adminAccounts, adminPlans, adminAccountEntitlement } from '../../lib/admin';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function resourceLabel(resource: string): string {
  return isValidEntitlementResource(resource) ? ENTITLEMENT_RESOURCE_SPEC[resource].label : resource;
}

function EffectivePolicy({ accountId }: { accountId: string }) {
  const { data, loading, error } = useAsync<AccountEntitlementDto>(
    () => adminAccountEntitlement(accountId),
    [accountId],
  );

  if (loading) return <Empty>Loading effective policy…</Empty>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Effective policy - {data.plan.name}
          {data.plan.isDefault ? ' (default)' : ''}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Period {fmtDate(data.period.start)} - {fmtDate(data.period.end)}
        </p>
        {data.allowances.length === 0 ? (
          <Empty>No resource allowances are defined for this plan.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Resource</TableHead>
                <TableHead>Allowance</TableHead>
                <TableHead className="text-right">Consumed</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead>Funding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.allowances.map((a) => (
                <TableRow key={a.resource}>
                  <TableCell>
                    <div className="font-medium">{resourceLabel(a.resource)}</div>
                    <div className="font-mono text-xs text-muted-foreground">{a.resource}</div>
                  </TableCell>
                  <TableCell>
                    {a.allowance === null ? 'No cap' : fmtNum(a.allowance)}{' '}
                    <span className="text-xs text-muted-foreground">/ {a.period}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(a.consumed)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {a.remaining === null ? '—' : fmtNum(a.remaining)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.operatorFunded ? 'Operator-funded' : 'User-funded'}
                    {a.byokExempt ? ' · BYOK exempt' : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function AdminPlans() {
  const plansState = useAsync(() => adminPlans(), []);
  const accountsState = useAsync(() => adminAccounts(), []);
  const [accountId, setAccountId] = useState('');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plans & policy"
        description="Product plans and the effective per-resource policy an account resolves to. Policy visibility only - no pricing or billing."
      />

      {plansState.loading ? (
        <Empty>Loading plans…</Empty>
      ) : plansState.error ? (
        <p className="text-sm text-destructive">{plansState.error}</p>
      ) : !plansState.data || plansState.data.length === 0 ? (
        <Empty>No plans</Empty>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Plans</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Features</TableHead>
                  <TableHead className="text-right">Allowances</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plansState.data.map((plan) => (
                  <TableRow key={plan.key}>
                    <TableCell className="font-mono text-xs">{plan.key}</TableCell>
                    <TableCell>
                      {plan.name}
                      {plan.is_default && (
                        <Badge variant="secondary" className="ml-2">
                          Default
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={plan.status === 'active' ? 'outline' : 'destructive'}>{plan.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {plan.features.length === 0 ? '—' : plan.features.join(', ')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(plan.allowance_count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inspect an account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Account</span>
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              className="min-w-64 rounded-md border bg-background px-2 py-1 text-sm"
              aria-label="Account"
            >
              <option value="">Select an account…</option>
              {(accountsState.data ?? []).map((account) => (
                <option key={account.account_id} value={account.account_id}>
                  {account.name} ({account.account_id})
                </option>
              ))}
            </select>
          </label>
          {accountId ? (
            <EffectivePolicy accountId={accountId} />
          ) : (
            <Empty>Choose an account to inspect its effective policy.</Empty>
          )}
        </CardContent>
      </Card>
    </div>
  );
}