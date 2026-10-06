/**
 * Shared plan & allowance UI (P15).
 *
 * One set of presentational pieces reused by the account Usage report and the
 * customer-facing Plan catalog so the two surfaces can never disagree about how
 * a plan, its price, or an allowance is described. These components are purely
 * presentational: they read DTOs already resolved by the API and never enforce
 * anything (enforcement lives in the P14 admission path server-side).
 */
import type { AccountEntitlementDto, CustomerPlanDto, EntitlementAllowanceDto, PlanPricingDto } from '@seo/contracts';
import { ENTITLEMENT_RESOURCE_SPEC, isValidEntitlementResource } from '@seo/contracts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtDate, fmtNum } from '../../lib/ui';

const FEATURE_LABELS: Record<string, string> = {
  api_access: 'API access',
  mcp_access: 'MCP access',
  ai_editing: 'AI editing',
  writing: 'Writing',
  publishing: 'Publishing',
  designer: 'Designer',
  composer: 'Composer',
};

export function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature;
}

export function resourceLabel(resource: string): string {
  return isValidEntitlementResource(resource) ? ENTITLEMENT_RESOURCE_SPEC[resource].label : resource;
}

/** Integer minor units -> localized currency, e.g. 1900 EUR -> "€19.00". */
function money(amount: number, currency: string | null): string {
  const value = amount / 100;
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
    } catch {
      return `${value.toFixed(2)} ${currency}`;
    }
  }
  return value.toFixed(2);
}

/**
 * The human price statement for a plan. Honest by construction: a draft price
 * says so, an undecided price says "Contact us", and a genuinely free plan says
 * "Free" - it never invents a number the catalog does not have.
 */
export function planPriceLabel(pricing: PlanPricingDto): string {
  if (pricing.priceLabel) return pricing.priceLabel;
  if (pricing.priceStatus === 'draft') return 'Pricing to be confirmed';
  if (pricing.monthlyPrice === null && pricing.yearlyPrice === null) return 'Contact us';
  if (pricing.monthlyPrice === 0 && pricing.yearlyPrice === 0) return 'Free';
  const parts: string[] = [];
  if (pricing.monthlyPrice !== null) parts.push(`${money(pricing.monthlyPrice, pricing.currency)}/mo`);
  if (pricing.yearlyPrice !== null) parts.push(`${money(pricing.yearlyPrice, pricing.currency)}/yr`);
  return parts.join(' · ') || 'Contact us';
}

/** "41 / 100 used" style, or an explicit statement when the plan does not cap it. */
export function allowanceUsage(a: EntitlementAllowanceDto): string {
  if (a.allowance === null) return `${fmtNum(a.consumed)} used (no plan cap)`;
  if (a.allowance === 0) return 'Not included';
  return `${fmtNum(a.consumed)} / ${fmtNum(a.allowance)} used`;
}

export function remainingText(a: EntitlementAllowanceDto): string {
  if (a.remaining === null) return 'No plan cap';
  if (a.allowance === 0) return 'Not included on this plan';
  return `${fmtNum(a.remaining)} remaining`;
}

export type AllowanceState = 'ok' | 'low' | 'exhausted' | 'none';

/** Classify an allowance so the UI can warn before a caller hits the limit. */
export function allowanceState(a: EntitlementAllowanceDto): AllowanceState {
  if (a.allowance === 0) return 'none';
  if (a.allowance === null || a.remaining === null) return 'ok';
  if (a.remaining <= 0) return 'exhausted';
  if (a.remaining <= Math.max(1, a.allowance * 0.1)) return 'low';
  return 'ok';
}

/** One compact resource card: usage, remaining and the funding behaviour. */
export function AllowanceCard({ a }: { a: EntitlementAllowanceDto }) {
  const state = allowanceState(a);
  return (
    <div className="space-y-1 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{resourceLabel(a.resource)}</span>
        {a.status === 'disabled' && <Badge variant="destructive">Disabled</Badge>}
        {a.status !== 'disabled' && state === 'exhausted' && <Badge variant="destructive">Used up</Badge>}
        {a.status !== 'disabled' && state === 'low' && <Badge variant="secondary">Almost used up</Badge>}
      </div>
      <div className="text-lg tabular-nums">{allowanceUsage(a)}</div>
      <div className="text-xs text-muted-foreground">
        {remainingText(a)} · {a.unit}
      </div>
      {a.status !== 'disabled' && a.byokExempt && (
        <div className="text-xs text-muted-foreground">Your own key usage does not count</div>
      )}
    </div>
  );
}

/** The plan's price, presented as a badge in both the catalog and current plan. */
export function PricingTag({ pricing }: { pricing: PlanPricingDto }) {
  const draft = pricing.priceStatus === 'draft';
  return (
    <Badge variant={draft ? 'secondary' : 'outline'} title={draft ? 'Provisional price' : undefined}>
      {planPriceLabel(pricing)}
    </Badge>
  );
}

/** One customer-facing catalog entry: what the plan costs and what it includes. */
export function CatalogPlanCard({ plan }: { plan: CustomerPlanDto }) {
  const enabled = plan.features.filter((f) => f.enabled);
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base font-medium">{plan.displayName || plan.name}</span>
          {plan.isDefault && <Badge variant="secondary">Default</Badge>}
        </div>
        <PricingTag pricing={plan.pricing} />
      </div>
      {plan.description && <p className="text-sm text-muted-foreground">{plan.description}</p>}
      <div className="flex flex-wrap gap-1.5">
        {enabled.length === 0 ? (
          <span className="text-sm text-muted-foreground">No product capabilities enabled.</span>
        ) : (
          enabled.map((f) => (
            <Badge key={f.feature} variant="outline">
              {featureLabel(f.feature)}
            </Badge>
          ))
        )}
      </div>
      {plan.allowances.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Included per period</div>
          <ul className="space-y-0.5 text-sm">
            {plan.allowances.map((a) => (
              <li key={a.resource} className="flex items-center justify-between gap-2">
                <span>{resourceLabel(a.resource)}</span>
                <span className="tabular-nums text-muted-foreground">
                  {a.allowance === null ? 'No cap' : fmtNum(a.allowance)} {a.unit}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.billingIntervals.length > 0 && (
        <div className="text-xs text-muted-foreground">
          Billing: {plan.billingIntervals.join(' or ')}
        </div>
      )}
    </div>
  );
}

/**
 * The account's current plan and resolved allowances for this period. Shared by
 * the Usage report and the Plan view so both describe the effective plan
 * identically.
 */
export function CurrentPlanCard({ entitlement }: { entitlement: AccountEntitlementDto }) {
  const enabled = entitlement.features.filter((f) => f.enabled);
  const hosted = entitlement.allowances.filter((a) => a.operatorFunded);
  const byok = entitlement.allowances.filter((a) => a.operatorFunded && a.byokExempt);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Plan &amp; allowances</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{entitlement.plan.displayName || entitlement.plan.name}</span>
          <PricingTag pricing={entitlement.plan.pricing} />
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
                {featureLabel(f.feature)}
              </Badge>
            ))
          )}
        </div>

        {hosted.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Hosted resources</div>
            <p className="text-xs text-muted-foreground">
              Usage funded by Old Skool SEO consumes your plan allowance for this period.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {hosted.map((a) => (
                <AllowanceCard key={a.resource} a={a} />
              ))}
            </div>
          </div>
        )}

        {byok.length > 0 && (
          <div className="space-y-1 rounded-lg border border-dashed p-3">
            <div className="text-sm font-medium">Your own keys</div>
            <p className="text-xs text-muted-foreground">
              {byok.map((a) => resourceLabel(a.resource)).join(', ')}: when you connect your own provider key,
              usage runs on your account and does not consume the hosted allowance.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
