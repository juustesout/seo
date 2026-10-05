/**
 * Usage view (R5.10.8), extended with the P13 entitlement read model.
 *
 * Minimal read-only report over the append-only usage ledger: aggregate
 * consumption grouped by category/provider/operation/unit with a total quantity
 * and event count. Deliberately no charts, pricing, budgets, invoices or cost -
 * the ledger stores facts, and cost is a future derivation from facts + pricing.
 *
 * One component serves both scopes: pass a `projectId` for the project's own
 * consumption (`GET /api/projects/:id/usage`), omit it for the caller's account
 * (`GET /api/account/usage`). Both endpoints return the same `UsageReportDto`.
 * The account scope additionally shows the P13 plan/allowance read model
 * (`GET /api/account/entitlement`): current plan, enabled capabilities and
 * per-resource operator-funded allowance vs this-period consumption.
 */
import type { AccountEntitlementDto, EntitlementAllowanceDto, UsageReportDto } from '@seo/contracts';
import { ENTITLEMENT_RESOURCE_SPEC, isValidEntitlementResource } from '@seo/contracts';
import { api } from '../lib/api';
import { useAsync, fmtNum, fmtDate, Empty } from '../lib/ui';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const FEATURE_LABELS: Record<string, string> = {
  api_access: 'API access',
  mcp_access: 'MCP access',
  ai_editing: 'AI editing',
  writing: 'Writing',
  publishing: 'Publishing',
  designer: 'Designer',
  composer: 'Composer',
};

function resourceLabel(resource: string): string {
  return isValidEntitlementResource(resource) ? ENTITLEMENT_RESOURCE_SPEC[resource].label : resource;
}

/** "41 / 100 used" style, or an explicit statement when the plan does not cap it. */
function allowanceUsage(a: EntitlementAllowanceDto): string {
  if (a.allowance === null) return `${fmtNum(a.consumed)} used (no plan cap)`;
  if (a.allowance === 0) return 'Not included';
  return `${fmtNum(a.consumed)} / ${fmtNum(a.allowance)} used`;
}

function EntitlementCard({ state }: { state: { data: AccountEntitlementDto | null; loading: boolean; error: string | null } }) {
  if (state.loading) return <Empty>Loading plan…</Empty>;
  if (state.error) return <p className="text-sm text-destructive">{state.error}</p>;
  const entitlement = state.data;
  if (!entitlement) return null;
  const enabled = entitlement.features.filter((f) => f.enabled);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Plan &amp; allowances</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{entitlement.plan.name}</span>
          {entitlement.plan.isDefault && <Badge variant="secondary">Default</Badge>}
          <span className="text-muted-foreground">
            Period {fmtDate(entitlement.period.start)} – {fmtDate(entitlement.period.end)}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {enabled.length === 0 ? (
            <span className="text-sm text-muted-foreground">No product capabilities enabled.</span>
          ) : (
            enabled.map((f) => (
              <Badge key={f.feature} variant="outline">
                {FEATURE_LABELS[f.feature] ?? f.feature}
              </Badge>
            ))
          )}
        </div>
        {entitlement.allowances.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plan allowances are defined.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Resource</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entitlement.allowances.map((a) => (
                <TableRow key={a.resource}>
                  <TableCell>
                    <div className="font-medium">{resourceLabel(a.resource)}</div>
                    <div className="text-xs text-muted-foreground">{a.unit}</div>
                  </TableCell>
                  <TableCell>{allowanceUsage(a)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {a.remaining === null ? '—' : fmtNum(a.remaining)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.status === 'disabled'
                      ? 'Disabled'
                      : a.allowance === null
                        ? 'No plan cap'
                        : a.byokExempt
                          ? 'Your own key usage does not count'
                          : 'Server-funded'}
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

export function Usage({ projectId }: { projectId?: string }) {
  const path = projectId ? `/projects/${projectId}/usage` : '/account/usage';
  const { data, loading, error } = useAsync<UsageReportDto>(() => api<UsageReportDto>(path), [path]);
  const entitlement = useAsync<AccountEntitlementDto | null>(
    () => (projectId ? Promise.resolve(null) : api<AccountEntitlementDto>('/account/entitlement')),
    [projectId],
  );
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
      {!projectId && <EntitlementCard state={entitlement} />}
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
