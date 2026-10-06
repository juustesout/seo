/**
 * Platform admin - plans, pricing & effective policy (P14, P15).
 *
 * Read-only view of the product catalog and the policy an account resolves to:
 * the configured plans with their customer-facing metadata (display name,
 * visibility, price metadata) and, for a chosen account, the effective resource
 * allowances with this-period consumption, remaining and funding behaviour.
 * Price fields are catalog metadata only - this is policy visibility, never
 * billing: there is no checkout, invoice, credit or payment here.
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
import { PricingTag } from '@/components/entitlement/planUi';

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
        description="Product plans, their catalog/pricing metadata and the effective per-resource policy an account resolves to. Policy visibility only - no checkout, invoicing or payment."
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
                  <TableHead>Visibility</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Features</TableHead>
                  <TableHead className="text-right">Allowances</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plansState.data.map((plan) => (
                  <TableRow key={plan.key}>
                    <TableCell className="font-mono text-xs">{plan.key}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{plan.display_name || plan.name}</span>
                        {plan.is_default && <Badge variant="secondary">Default</Badge>}
                      </div>
                      {plan.display_name && plan.display_name !== plan.name && (
                        <div className="text-xs text-muted-foreground">{plan.name}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={plan.status === 'active' ? 'outline' : 'destructive'}>{plan.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {plan.is_public ? (
                        <Badge variant="secondary">Public</Badge>
                      ) : (
                        <Badge variant="outline">Internal</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <PricingTag
                        pricing={{
                          currency: plan.currency,
                          monthlyPrice: plan.monthly_price,
                          yearlyPrice: plan.yearly_price,
                          priceStatus: plan.price_status,
                          priceLabel: plan.price_label,
                        }}
                      />
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