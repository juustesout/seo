/**
 * Customer-facing Plan view (P15).
 *
 * Reads the account's effective plan `/api/account/entitlement` alongside the
 * public plan catalog `/api/plans`. The effective card is the source of truth
 * for what this account can do right now; the catalog describes the plans the
 * product offers. Both are read-only: this platform does not process payments
 * or subscriptions, so a plan with no decided price is shown honestly as such
 * rather than with an invented figure or a checkout button.
 */
import type { AccountEntitlementDto, CustomerPlanDto } from '@seo/contracts';
import { api } from '../lib/api';
import { useAsync, Empty } from '../lib/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { CatalogPlanCard, CurrentPlanCard } from '@/components/entitlement/planUi';

export function Plan() {
  const entitlement = useAsync<AccountEntitlementDto>(() => api<AccountEntitlementDto>('/account/entitlement'));
  const catalog = useAsync<CustomerPlanDto[]>(() => api<CustomerPlanDto[]>('/plans'));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plan"
        description="The plan this account is on and the allowances it includes. Usage is measured per period."
      />

      {entitlement.loading ? (
        <Empty>Loading plan…</Empty>
      ) : entitlement.error ? (
        <p className="text-sm text-destructive">{entitlement.error}</p>
      ) : entitlement.data ? (
        <CurrentPlanCard entitlement={entitlement.data} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Available plans</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {catalog.loading ? (
            <Empty>Loading plans…</Empty>
          ) : catalog.error ? (
            <p className="text-sm text-destructive">{catalog.error}</p>
          ) : (catalog.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No public plans are available.</p>
          ) : (
            (catalog.data ?? []).map((plan) => <CatalogPlanCard key={plan.key} plan={plan} />)
          )}
          <p className="text-xs text-muted-foreground">
            Prices are shown for information only. This platform does not process payments or subscriptions.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
