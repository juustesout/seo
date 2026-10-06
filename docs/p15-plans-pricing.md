# P15 - Customer Plans & Pricing Model

P13 built the entitlement **engine** and P14 configured the first concrete
resource policies. P15 adds the **customer-facing commercial catalog** on top of
the same engine: plan identity, ordering, visibility, feature packaging and
price/billing metadata, plus the surfaces that present them.

P15 adds **no payment processing** and no second enforcement path. There is no
Stripe/checkout, no subscriptions, no invoices, no credits and no payment
provider. Pricing columns state what a plan is *offered at*; how much a plan
includes is still an entitlement allowance, and every limit is still enforced by
the P13/P14 admission path.

Baseline documents:

- `docs/p13-entitlement-foundation.md` - the entitlement engine.
- `docs/p14-resource-policies.md` - concrete resource policies + enforcement.
- `docs/p12-entitlement-monetization-recon.md` - the monetization recon.

## 1. Scope of P15

What P15 changes, concretely:

1. **Plan catalog vocabulary and DTOs** in
   `packages/contracts/src/entitlement.ts`: billing intervals, price status,
   `PlanPricingDto`, `PlanSummaryDto`, `PlanAllowanceDto`, `CustomerPlanDto`,
   plus guards and length limits.
2. **Catalog + pricing columns** on `seo_plans` (migration
   `20260101000043_p15_plans_pricing.sql`) with constraints, comments and an
   idempotent backfill.
3. **A customer catalog read** (`EntitlementService.listCustomerPlans` and
   `GET /api/plans`): the active, public plans with features, allowances and
   pricing metadata.
4. **A safe base plan**: the default plan's operator-funded hosted resources
   become explicitly `0` (not uncapped), and it gets a decided `Free` identity.
5. **Draft commercial tiers** (`starter`, `pro`, `agency`) as internal,
   disabled, hidden structure only - no invented prices or allowances.
6. **Web surfaces**: a customer-facing `Plan` view, the existing `Usage` view
   reusing the same components, and pricing metadata in the admin plans table.
7. **Smoke checks** for the catalog/pricing metadata in
   `scripts/db-migrate-local.sh`.

P15 reuses P13/P14 unchanged: no duplicate plan model, no second enforcement
path, and no alternative code path that reads a plan allowance directly.

## 2. Plan catalog vocabulary

Closed vocabularies in `@seo/contracts`:

- `PLAN_BILLING_INTERVALS = ['monthly', 'yearly']` - the intervals a plan may be
  offered on. Product metadata only; there is no renewal or subscription
  lifecycle.
- `PLAN_PRICE_STATUSES = ['draft', 'final']` - whether a plan's commercial price
  is still a provisional decision or has been decided.

Money is **always integer minor units** (`EUR 19.00` -> `1900`), never floating
point. `PlanPricingDto`:

| Field | Meaning |
| --- | --- |
| `currency` | ISO 4217 code, or `null` when undecided (`^[A-Z]{3}$` in the DB). |
| `monthlyPrice` | Monthly price in minor units, or `null` when undecided. |
| `yearlyPrice` | Yearly price in minor units, or `null` when undecided. |
| `priceStatus` | `draft` or `final`. |
| `priceLabel` | Optional display override, e.g. `Free` / `Contact us`. |

`PlanSummaryDto` is the plan identity + commercial metadata (no account state);
`CustomerPlanDto` extends it with `features` and `allowances`;
`AccountEntitlementDto.plan` is a `PlanSummaryDto`. `PlatformAdminPlanDto`
carries the same catalog fields for the admin read.

## 3. Schema (migration 043)

New `seo_plans` columns, all idempotent, with constraints:

| Column | Type | Notes |
| --- | --- | --- |
| `display_name` | `text not null` | Customer-facing name; backfilled from `name`; length 1..120. |
| `sort_order` | `integer not null default 0` | Catalog ordering; `>= 0`. |
| `is_public` | `boolean not null default true` | Whether the plan appears in the customer catalog. |
| `currency` | `text` | `null` or `^[A-Z]{3}$`. |
| `monthly_price` | `integer` | `null` or `>= 0` (minor units). |
| `yearly_price` | `integer` | `null` or `>= 0` (minor units). |
| `price_status` | `text not null default 'draft'` | `draft` or `final`. |
| `price_label` | `text` | `null` or length 1..40. |
| `billing_intervals` | `text[] not null default {monthly,yearly}` | Subset of `{monthly,yearly}`, at least one. |

The existing `status` (`active`/`disabled`) still gates assignment and
enforcement; `is_public` is a separate presentation flag. The admin read
function `seo_platform_admin_plans(uuid)` is redefined to return the catalog
columns and stays `service_role` only.

## 4. The base (Free) plan

The default plan keeps the **full product for every authenticated user** in the
sense that features and the technical P9/P11 floor are unchanged, but P15
tightens the operator-funded placeholder:

- `display_name = 'Free'`, `is_public = true`, `sort_order = 0`,
  `currency = null`, `monthly_price = 0`, `yearly_price = 0`,
  `price_status = 'final'`, `price_label = 'Free'`.
- The four operator-funded hosted resources (`ai_generation`, `ai_image`,
  `dataforseo_research`, `media`) are set to allowance **`0`** ("hosted not
  included") instead of P14's `null` (uncapped).
- `x_link_post` stays `0`.

This is the safe default: a brand-new account can never consume operator budget
by accident. BYOK still works on the free plan because
`ai_generation`/`ai_image`/`dataforseo_research` are `byok_exempt`; connecting
your own key consumes no operator allowance. The concrete free-tier hosted
amounts remain an explicit, open product decision - not fabricated here.

> This supersedes the P14 base-plan table (which left hosted resources
> uncapped). See the correction note in `docs/p14-resource-policies.md` section 3.

Policy semantics are unchanged: `allowance is null` = no product cap;
`allowance = 0` = not included; a positive number is the included amount.

## 5. Draft commercial tiers

`starter`, `pro` and `agency` are seeded as **internal drafts**: `status =
'disabled'`, `is_public = false`, `price_status = 'draft'`, no currency and no
prices. They exist only to prove the catalog can express paid tiers; they cannot
be assigned while disabled and are never shown to customers. P12 section 23
("do not invent Free/Pro/Agency") and the P15 brief ("do not invent prices")
forbid fabricating their values, so their pricing and included hosted amounts
stay `null` until a real product decision sets them.

## 6. Service and API

- `EntitlementService.listCustomerPlans()` reads `seo_plans` where
  `status = 'active' AND is_public = true`, ordered by `sort_order` then `key`,
  and joins each plan's active feature rows and active resource policies. It
  returns `CustomerPlanDto[]`; a read error becomes `500 storage_error`
  (never a fake empty catalog).
- `GET /api/plans` (`apps/api/src/http/routes/plans.ts`, mounted in `app.ts`)
  requires authentication and returns `{ data: CustomerPlanDto[] }`. Any
  authenticated user may read the catalog: it is product information and carries
  no account state.
- The account's *effective* limits are still `GET /api/account/entitlement`
  (unchanged), and the admin catalog read is still `GET /api/admin/plans`.
  Nothing in the catalog path resolves or enforces an account allowance.

## 7. Web surfaces

- **`apps/web/src/views/Plan.tsx`** (`/plan`, account area): the current plan
  card plus the public catalog. It states plainly that prices are informational
  and that no payments or subscriptions are processed.
- **`apps/web/src/components/entitlement/planUi.tsx`**: the shared presentational
  pieces (`CatalogPlanCard`, `CurrentPlanCard`, `AllowanceCard`, `PricingTag`,
  `planPriceLabel`, allowance classification). Both the Plan and Usage views use
  them so they can never describe a plan differently.
- **Allowance-exhaustion UX**: `AllowanceCard` classifies an allowance as
  `ok`/`low`/`exhausted`/`none` and shows `Used up` / `Almost used up` badges,
  and `resourceErrorMessage` maps the server's `entitlement_limit` denial to
  actionable copy (wait for the next period, or connect your own key).
- **`apps/web/src/views/Usage.tsx`**: re-exports the current-plan card through
  the shared component (no duplicate UI).
- **`apps/web/src/views/admin/AdminPlans.tsx`**: the plans table now shows
  display name, visibility, and a pricing badge alongside the existing policy
  columns.

Pricing is honest by construction: a `priceLabel` is shown if set; a `draft`
price shows "Pricing to be confirmed"; an all-null price shows "Contact us"; a
zero final price shows "Free". No number is invented.

## 8. Security and boundaries

- The catalog read uses the service-role client and returns a DTO; the browser
  never sees raw plan rows, another account's data or provider credentials.
- Admin catalog/policy reads keep the P3 trust boundary
  (`requirePlatformAdmin` + `seo_assert_platform_admin`, `service_role`-only
  RPCs). RLS remains the boundary for every `seo_*` table.
- No new secrets, no pricing logic in the client, and no client-side enforcement.

## 9. What P15 does not do

- No Stripe/checkout/subscriptions/invoices/payments/credits.
- No invented prices or tiers: the paid tiers are disabled, hidden drafts.
- No fabricated free-tier hosted amounts: base hosted allowances are `0`, an
  explicit "not included", not an invented number.
- No second plan model or enforcement path: all limits still flow through the
  P13/P14 entitlement admission layer.
- No alternative route that reads a plan allowance (e.g. `plan.ai_text_limit`)
  directly.
