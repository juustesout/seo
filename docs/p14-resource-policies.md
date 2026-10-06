# P14 - Product Resource Policies & Usage Enforcement

P13 built the entitlement **engine** (plans, features, allowances, reservations,
the atomic admission function and the read model). P14 is the **implementation
pass**: it ships the first concrete product policy for Old Skool SEO, makes the
resource registry canonical, attributes funding at the real call sites, and
enforces the operator-funded allowances where the work actually happens.

P14 adds **no payment processing** and no new tables. It configures the P13
engine with real values, closes the gaps between the registry, the stored rows,
the read model and enforcement, and documents exactly which server-funded
operations are bounded and attributable.

Baseline documents:

- `docs/p9-resource-protection.md` - async job admission.
- `docs/p11-resource-protection.md` - sync admission, funding attribution.
- `docs/p13-entitlement-foundation.md` - the entitlement engine P14 builds on.
- `docs/p12-entitlement-monetization-recon.md` - the recon (sections 4-6).

## 1. Scope of P14

What P14 changes, concretely:

1. **Canonical resource registry.** `ENTITLEMENT_RESOURCE_SPEC`
   (`packages/contracts/src/entitlement.ts`) is now the single source of truth
   for each product resource: its ledger category, exact ledger unit(s), funding
   model, human/product labels and a plain-language metering definition.
2. **Concrete base-plan policy.** Migration
   `20260101000042_p14_resource_policies.sql` seeds/aligns the `base` plan's
   resource policies with that registry.
3. **Funding attribution at the seams.** The operator-vs-BYOK decision is made
   by mirroring the credential precedence the provider itself uses, before the
   call, so the allowance that is at stake is known without a second accounting
   path.
4. **Enforcement wired to real call sites** (AI text/image, DataForSEO research
   and SERP, stock media search, X link posts).
5. **Admin + UI read surfaces** for the effective policy (`GET
   /api/admin/accounts/:accountId/entitlement`; the account Usage view's
   hosted-vs-BYOK split).
6. **A canonical registry smoke check** in `scripts/db-migrate-local.sh`.

P14 deliberately does **not** change P9/P11 (they stay plan-unaware), does not
add a second ledger, and does not invent commercial ceilings it cannot justify.

## 2. The canonical resource registry

`ENTITLEMENT_RESOURCE_SPEC` owns the resource vocabulary
(`ENTITLEMENT_RESOURCES`). The registry is what the database rows, the read
model, the UI and enforcement all agree on:

| Product resource | Ledger category | Ledger units | Funding model | BYOK exempt | Product unit |
| --- | --- | --- | --- | --- | --- |
| `ai_generation` | `ai` | `input_token`, `output_token` | `byok_or_operator` | yes | tokens |
| `ai_image` | `media` | `image_generation` | `byok_or_operator` | yes | images |
| `dataforseo_research` | `dataforseo` | `request`, `serp_request` | `byok_or_operator` | yes | requests |
| `media` | `media` | `request` | `operator` | no | searches |
| `x_link_post` | `publishing` | `publish_attempt` | `operator` | no | link posts |

Design points:

- **Exact units only.** There is deliberately no "all units in the category"
  fallback. Summing a whole category mixed sub-units (DataForSEO's `keyword`
  and `task` alongside the billable `request`, for example) and overstated
  consumption. Every resource names the exact unit(s) that constitute one
  billable request.
- **`ai_image` is a `media` resource**, not `ai`: it is measured in generated
  images (`image_generation`) and shares the media category with stock search.
- **`ai_generation` is `byok_or_operator`.** If the account uses its own LLM key
  (`USER_LLM_API_KEY`), the operator paid nothing and a BYOK-exempt allowance is
  not consumed.
- **`x_link_post` is separate from `publishing`.** `publishing` is a technical
  class (WordPress is user-funded and free); an X post carrying a link incurs a
  real per-post operator cost and is its own consumption resource.

## 3. The base plan

`ENTITLEMENT_BASE_PLAN_KEY = 'base'` is the plan every account resolves when it
has no explicit binding. It preserves the **full product**: every feature
enabled, and every operator-funded allowance uncapped (`null`) **except**
`x_link_post`, which is `0` by default.

Migration 042 seeds exactly five policies on `base` (idempotent
`INSERT ... ON CONFLICT`), with `period = 'month'`, `scope = 'account'`,
`operator_funded = true` and `byok_exempt` matching the funding model:

| Resource | Unit | Allowance | Why |
| --- | --- | --- | --- |
| `ai_generation` | `tokens` | `null` (uncapped) | Operator cost is real but the commercial ceiling is a P12-undecided product decision; the technical P9/P11 floor still applies. |
| `ai_image` | `images` | `null` (uncapped) | Same. |
| `dataforseo_research` | `requests` | `null` (uncapped) | Same. |
| `media` | `searches` | `null` (uncapped) | Same. |
| `x_link_post` | `link_posts` | `0` (not included) | X bills ~EUR0.20 for a post carrying a link; this is the one resource with an unambiguous per-unit operator cost, so the base plan does not give it away unlimited. |

The rule P14 follows: **do not fabricate commercial ceilings.** Only
`x_link_post` gets a concrete non-null value, because its per-unit operator cost
is known and unavoidable. Everything else stays `null` (bounded only by the
technical floor) until a real product decision sets a number. The line between
operator cost and customer price is kept clean; future billing can attach a
price without a schema or engine change.

Policy semantics are unchanged from P13: `allowance is null` means no product
cap; `allowance = 0` means not included.

> P15 corrected this table: the base plan's operator-funded hosted resources
> (`ai_generation`, `ai_image`, `dataforseo_research`, `media`) are now
> explicitly `0` ("hosted not included") rather than `null` (uncapped), so a new
> account cannot consume operator budget by default. BYOK is unaffected (those
> resources stay `byok_exempt`). See `docs/p15-plans-pricing.md` section 4.

## 4. Funding attribution

An operator allowance is only at stake when the operator actually pays. P14
resolves the funding source **before** the call, by mirroring the exact
credential precedence the provider adapter uses:

- **AI text / AI image** (`contentAgentService`, `imageInsertionService`): the
  generation's own credential resolution yields a key source; a BYOK key
  attributes `byok`, a server key attributes `operator_funded`. A resource whose
  funding cannot be determined upfront stays `null` and consumes no operator
  allowance.
- **DataForSEO** (`providers/dataforseo/funding.ts`,
  `resolveDataForSeoFundingSource`): walks the same stored-credential →
  environment-credential precedence as `DataForSeoDataSource.clientFor`. A stored
  (user) credential is BYOK; an environment credential is operator-funded. The
  stored-credential lookup uses the project's `seo_integrations` row, so
  attribution is per project.
- **Stock media search** and **X link posts** are always `operator_funded`: they
  run through the server's own app/provider with no user-supplied alternative.

Consequences (from P13, restated because P14 relies on them):

- **operator-funded** consumption is what an allowance bounds and would sell.
- **BYOK** on a `byok_exempt` resource consumes **no** operator allowance (still
  bounded technically and by feature entitlements).
- **unattributable (`null`)** is not assumed operator-funded, so it consumes no
  operator allowance; the read model still reports the resource.

## 5. Enforcement at the call sites

Every server-funded operation admits through the entitlement seam before doing
provider work (`EntitlementService.withAdmission`), and records usage against the
one ledger. Nothing is enforced with a second counter.

| Operation | Resource | Metered amount | Funding |
| --- | --- | --- | --- |
| AI text generation (`ContentAgentService.generate`) | `ai_generation` | provider token counts (usage) | resolved per credential |
| AI image generation (`imageInsertionService`, `contentImages` job) | `ai_image` | one image | resolved per credential |
| Stock media search (`imageInsertionService`, `contentImages` job) | `media` | one search request | operator-funded |
| DataForSEO rank sync (`dataForSeoRankSync`) | `dataforseo_research` | `keywords.length` requests | resolved (`funding.ts`) |
| DataForSEO SERP retrieval (`serpRetrieval`) | `dataforseo_research` | `keywords.length` requests | resolved |
| DataForSEO keyword research (legacy single call) | `dataforseo_research` | `1` request | resolved |
| DataForSEO keyword expansion | `dataforseo_research` | `expansionRequestAmount(methods, seeds)` | resolved |
| DataForSEO competitor research (discover) | `dataforseo_research` | `1` request | resolved |
| DataForSEO competitor research (content gap) | `dataforseo_research` | `competitors.length` requests | resolved |
| X publish with a link (`runRemoteWrite`, `publish`) | `x_link_post` | one attempt | operator-funded |

Notes:

- **DataForSEO is metered on billable units only.** The amount is expressed in
  `request` / `serp_request` units; DataForSEO's own `keyword` and `task`
  sub-units never inflate the count.
- **X link detection happens at publish time.** The executor tests the rendered
  post body for a link; a link post is admitted against `x_link_post` before the
  remote write, while a plain X post, WordPress, and deletes skip the product
  check. `seo_entitlement_consumed` counts only `provider = 'x'` facts whose
  metadata marks a link.
- **Admission is not usage.** A denied request records no usage and consumes no
  allowance. Consumption is always derived from `seo_usage_events`.
- Denials map SE004 to a persistent `403 entitlement_limit`, distinct from the
  transient `429` used by P9/P11, so the UI never asks a user to retry something
  that will not change.

## 6. Periods

Period boundaries are deterministic UTC windows computed from a single instant
(`resolveAllowancePeriod`), not a stored period table: `day`, `month` and `year`
are calendar UTC windows, `week` starts Monday (ISO), and `none` is a lifetime
window. Changing a period changes only which window future reads and enforcement
use; historical usage is never rewritten. The base plan uses `month`.

## 7. API, admin and UI

- `GET /api/account/entitlement` - the caller's own resolved model (plan,
  enabled features, per-resource allowance vs this-period consumption and
  remaining). The account comes from the session, never a URL id.
- `GET /api/admin/plans` - platform-admin plan read (policy, no secrets).
- `POST /api/admin/accounts/:accountId/plan` - platform-admin plan assignment.
- `GET /api/admin/accounts/:accountId/entitlement` - platform-admin read of an
  account's **effective** policy. It re-verifies the actor with
  `seo_assert_platform_admin`, then delegates to the same
  `EntitlementService.accountEntitlement` the owner read uses, so there is no
  second accounting path and the admin view can never disagree with the owner
  view.
- Account Usage view (`apps/web/src/views/Usage.tsx`) splits resources into
  **Hosted resources** (operator-funded, with allowance/consumed/remaining) and
  **Your own keys** (BYOK), so a user can tell unbounded-BYOK from a real cap.
  There is no pricing page, checkout or payment UI.
- Admin UI (`apps/web/src/views/admin/AdminPlans.tsx`) shows the plans table and
  an effective-policy table for a chosen account.

## 8. Admin boundary and security

Plan policy reuses the P3 platform-admin trust boundary: the router requires
`container.access.requirePlatformAdmin`, and the service-role database functions
re-verify the actor with `seo_assert_platform_admin` (defense in depth). No
project role can read or mutate plan policy, and no email-based admin check or
new auth mechanism exists. RLS remains the boundary for every `seo_*` table;
enforcement runs on the service-role client authenticated as the caller.

## 9. What P14 does not do

- No payment processing, prices, credits, wallets, invoices or subscriptions.
- No change to P9/P11: they stay plan-unaware and always apply.
- No fabricated allowances: only `x_link_post` has a concrete value (`0`).
- No second usage ledger: consumption is derived from `seo_usage_events`.
- No per-resource endpoints beyond the account entitlement and admin read
  surfaces above.
