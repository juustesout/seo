# P13 - Entitlement & Monetization Foundation

P13 adds the first **product-policy** layer on top of the P9/P11 **technical**
resource protection. It lets an account resolve a plan, feature entitlements and
operator-funded resource allowances, and enforces that policy at the same
admission seam the technical ceilings already use.

P13 is deliberately **not billing**. There are no prices, credits, wallets,
invoices, subscriptions or payment processing. Cost remains a future derivation
from usage facts plus pricing rules. See `docs/p12-entitlement-monetization-recon.md`
for the recon this implementation is based on.

Baseline documents:

- `docs/p9-resource-protection.md` - async job admission (`seo_admit_job`).
- `docs/p11-resource-protection.md` - sync admission (`seo_admit_resource`),
  funding attribution.
- `docs/p12-entitlement-monetization-recon.md` - the entitlement/policy recon.
- `docs/r5.10.1-usage-vocabulary.md`, `docs/r5.10.2-usage-ledger.md`,
  `docs/r5.10.8-usage-read-reporting.md` - the usage vocabulary and ledger.

## 1. The model

```text
technical protection
    -> P9/P11 technical ceiling        (unchanged, plan-unaware)
    -> product entitlement / allowance  (this layer)
    -> actual usage                      (seo_usage_events, the one ledger)
    -> period accounting                 (derived, never stored)
```

The effective product limit is:

```text
effective = min(technical_ceiling, plan_allowance)
```

A plan can only ever **lower** the technical ceiling, never raise it:

- P9/P11 remain the floor and are always evaluated independently.
- The entitlement rejection happens **before** any provider work, so a finite
  allowance can only reduce what P9/P11 already allow.
- Where no policy applies (no plan binding, no active policy, `allowance is
  null`, a user-funded resource, or BYOK on an exempt resource) the entitlement
  layer returns "no product limit" and P9/P11 are the only limit.

**Admission is not usage.** Admission reserves; consumption is derived from the
append-only usage ledger. A denied request records no usage and consumes no
allowance.

## 2. Entities

Introduced by `supabase/migrations/20260101000041_entitlement_foundation.sql`:

| Object | Purpose |
| --- | --- |
| `seo_plans` | A named policy baseline (key, name, `is_default`, status). No price. |
| `seo_plan_features` | Plan -> feature on/off (`api_access`, `mcp_access`, `ai_editing`, `publishing`, `designer`, `composer`). |
| `seo_resource_policies` | Plan -> operator-funded resource allowance (`amount`, `period`, `scope`, `operator_funded`, `byok_exempt`, `status`). |
| `seo_account_entitlements` | Account -> plan binding, versioned by effective window; the active row (`effective_to is null`) is current. |
| `seo_entitlement_reservations` | Transient in-flight allowance holds (counted while unreleased and unexpired). Not a billing ledger. |

The default plan (`base`) preserves the full product: every feature enabled and
operator-funded allowances uncapped (`null`) **except** `x_link_post`, which is
`0` by default because it carries a real per-post operator cost. Every account
is bound to the default plan by a trigger, so an account always resolves a plan.

## 3. Effective enforcement

`seo_admit_entitlement` is the single atomic admission point:

- It reads consumption from the ledger via `seo_entitlement_consumed` (one SQL
  definition of "how much has been consumed this window", shared with the read
  model so they can never disagree).
- It adds active reservations for the same account/resource/period.
- It takes a per-account+resource advisory lock, so concurrent requests cannot
  oversubscribe an allowance.
- On exhaustion it raises **SE004** with message `seo_entitlement_limit`, a code
  distinct from the transient P9/P11 codes (SE001/SE002/SE003).

The application maps SE004 to a persistent `403 entitlement_limit`, separate
from the `429` used for transient technical limits, so the UI never tells a user
to retry something that will not change, and never tells them to upgrade for a
transient queue.

### Resources and their ledger mapping

The product resource vocabulary is
`ENTITLEMENT_RESOURCES` (`packages/contracts/src/entitlement.ts`), mapped onto
the existing usage vocabulary by `ENTITLEMENT_RESOURCE_SPEC`:

| Product resource | Ledger category | Ledger units | Notes |
| --- | --- | --- | --- |
| `ai_generation` | `ai` | `input_token`, `output_token` | BYOK-exempt by default |
| `ai_image` | `ai` | `image_generation` | BYOK-exempt by default |
| `dataforseo_research` | `dataforseo` | all units | BYOK-exempt by default |
| `media` | `media` | `asset` | operator-funded |
| `x_link_post` | `publishing` | `publish_attempt` | only attempts whose metadata marks a link; allowance `0` by default |

Consumption is always read from `seo_usage_events`, never a second ledger.

> P14 made this registry canonical and corrected some P13 provisional values:
> `ai_image` is measured in the `media` category (unit `image_generation`), and
> `media` is measured in `request` units. See
> `docs/p14-resource-policies.md` section 2 for the authoritative table.

## 4. Funding and BYOK

`funding_source` (added in P11) decides whether an operator allowance is at
stake:

- **operator-funded** consumption is what an allowance bounds and would sell.
- **BYOK** means the operator paid nothing, so on a `byok_exempt` resource it
  consumes **no** operator allowance (it is still bounded technically and by
  feature entitlements).
- **unattributable (null)** is not assumed to be operator-funded, so it consumes
  no operator allowance.

Where a resource's funding cannot be determined before the call, the resolver
returns null and no allowance is consumed; the read model still reports the
resource.

## 5. X link posts

X publishing runs through the platform's OAuth app, so the operator pays per
post, and a post containing a link costs far more than a plain post. P13 models
this as the `x_link_post` product resource:

- The publish executor computes `hasLink` from the post body and attaches it to
  the `publish_attempt` usage fact's metadata.
- A link post is admitted against the `x_link_post` allowance before the remote
  write; a non-link post, WordPress, and deletes skip the product check.
- `seo_entitlement_consumed` counts only `provider = 'x'` facts with
  `metadata->>'hasLink' = 'true'`, so plain X posts are not charged.

See the correction note in `docs/p12-entitlement-monetization-recon.md` section 5:
X link posts are no longer classed as never-monetize; WordPress publishing still
is (user-funded).

## 6. Periods

Period boundaries are deterministic UTC windows computed from a single instant
(`resolveAllowancePeriod`), not a stored period table:

- `day`, `month`, `year` are calendar UTC windows;
- `week` starts Monday (ISO);
- `none` is a lifetime window.

Changing a period only changes which window future reads/enforcement use;
historical usage is never rewritten.

## 7. API and contracts

- `GET /api/account/entitlement` - the caller's own resolved model: plan,
  enabled features, per-resource operator-funded allowance vs this-period
  consumption and remaining, and the period window. The account comes from the
  session, never a URL id.
- `GET /api/admin/plans` - platform-admin plan read (policy, no secrets).
- `POST /api/admin/accounts/:accountId/plan` - platform-admin plan assignment.
- `GET /api/account/usage` and project usage are unchanged; the aggregate now
  accepts an optional funding-source filter.

All contracts live in `packages/contracts/src/entitlement.ts` and follow the
existing conventions (flat DTO interfaces, `as const` vocabularies, hand-rolled
guards).

## 8. Admin boundary

Plan policy reuses the P3 platform-admin trust boundary: the router requires
`container.access.requirePlatformAdmin`, and the service-role database functions
re-verify the actor with `seo_assert_platform_admin` (defense in depth). No
project role can read or mutate plan policy, and no email-based admin check or
new auth mechanism exists.

## 9. UI

The account Usage view (`apps/web/src/views/Usage.tsx`) shows the plan, enabled
capabilities, and each resource's usage/remaining for the current period, with a
BYOK/no-plan-cap distinction. This is intentionally minimal: no pricing page, no
checkout, no Stripe UI. The data model makes a future upgrade/payment flow
possible without pretending one exists today.

## 10. What P13 does not do

- No payment processing, prices, credits, wallets, invoices or subscriptions.
- No change to P9/P11: they stay plan-unaware and always apply.
- No second usage ledger: consumption is derived from `seo_usage_events`.
- No per-resource endpoints beyond the single account entitlement surface.
