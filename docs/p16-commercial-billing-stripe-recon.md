# P16 - Commercial Billing & Stripe Recon

P13 built the entitlement engine, P14 shipped concrete resource policies and
enforcement, and P15 added the customer-facing plan catalog with pricing
metadata. P16 is **recon and architecture decision only**: it determines how a
real commercial subscription/billing layer with **Stripe as the intended payment
provider** attaches to that architecture without redesigning entitlement, usage,
resource protection or account ownership.

P16 ships **no billing implementation**. There is no Stripe SDK, no Stripe API
call, no checkout, no payment link, no subscription, no invoice, no webhook, no
customer creation, no billing cron and no automatic plan mutation. The only
deliverable is this document.

Baseline documents:

- `docs/p13-entitlement-foundation.md` - the entitlement engine.
- `docs/p14-resource-policies.md` - concrete resource policies + enforcement.
- `docs/p15-plans-pricing.md` - plan catalog + pricing metadata.
- `docs/p10-resource-economics-monetization-recon.md`,
  `docs/p12-entitlement-monetization-recon.md` - earlier commercial recon.
- `docs/platform-admin-bootstrap.md` - the platform-admin trust boundary.

The target end architecture:

```text
                    ┌──────────────────┐
                    │      STRIPE      │
                    │ customer/payment │
                    │ subscription     │
                    └────────┬─────────┘
                             │
                       verified events
                             │
                             ▼
                    ┌──────────────────┐
                    │ BILLING STATE    │
                    │ commercial truth │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │   P15 PLAN       │
                    │ Free / paid tier │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ P13 ENTITLEMENT  │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ P14 ALLOWANCES   │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ P9/P11 PROTECT   │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ PROVIDER / USAGE │
                    └──────────────────┘
```

**Stripe decides whether the customer has commercially paid. Old Skool SEO
decides what the commercially purchased plan may do.**

## 1. Current Architecture (code-grounded)

### 1.1 Identity and ownership

| Layer | Table | Key facts |
| --- | --- | --- |
| Identity | `auth.users` (Supabase) | Session bearer token verified by the API. |
| Commercial owner | `seo_accounts` | `owner_user_id` is **unique**: one user = one account today. `id` is the money boundary. |
| Tenant | `seo_projects` | `account_id` FK; a project belongs to exactly one account. |
| Membership | `seo_project_members` | Project roles (owner/admin/editor/viewer); never platform admin. |

A future `seo_account_members` table is anticipated in the account migration
comment, but **does not exist yet** (P16 section 3 treats this as an open
decision).

### 1.2 P13 - entitlement engine

- `seo_plans` - named plan policy baseline (`key` unique, at most one
  `is_default` via partial unique index).
- `seo_plan_features` - plan -> feature on/off (`api_access`, `mcp_access`,
  `ai_editing`, `publishing`, `designer`, `composer`).
- `seo_resource_policies` - plan -> operator-funded resource allowance
  (`resource`, `unit`, `period`, `scope`, `operator_funded`, `byok_exempt`,
  `status`, `allowance`). `allowance IS NULL` = no product cap; `0` = not
  included.
- `seo_account_entitlements` - account -> plan binding, **append-only history**;
  exactly one active row per account (`effective_to IS NULL`) via a partial
  unique index. The active row is the current plan.
- `seo_entitlement_reservations` - transient in-flight holds; the row *is* a
  pending consumption until released/expired. Never a billing ledger.
- Functions: `seo_admit_entitlement(...)` (atomic, advisory-locked, raises
  `SE004`/`seo_entitlement_limit`), `seo_entitlement_consumed(...)` (the one SQL
  definition of period consumption), `seo_release_entitlement(...)`.
- A trigger (`seo_assign_default_plan`) binds **every new account** to the
  default plan.

Effective product limit is `min(technical_ceiling, plan_allowance)`; a plan can
only lower, never raise, the P9/P11 technical ceiling.

### 1.3 P14 - concrete resource policies + enforcement

- Registry `ENTITLEMENT_RESOURCE_SPEC` (contracts): `ai_generation`, `ai_image`,
  `dataforseo_research`, `media`, `x_link_post` with exact ledger units and
  funding model.
- Funding attribution happens **before** the provider call
  (`resolveDataForSeoFundingSource`, credential-precedence mirroring); media and
  X link posts are always operator-funded.
- Enforcement is wired at the real call sites through
  `EntitlementService.withAdmission`; nothing is enforced with a second counter.
- `seo_usage_events.funding_source in ('byok','operator_funded')` (added P11).

### 1.4 P15 - catalog and pricing metadata

- Catalog/pricing columns on `seo_plans`: `display_name`, `sort_order`,
  `is_public`, `currency`, `monthly_price`, `yearly_price` (integer **minor
  units**), `price_status` (`draft`/`final`), `price_label`,
  `billing_intervals` (`monthly`/`yearly`).
- `EntitlementService.listCustomerPlans()` + `GET /api/plans` (any authenticated
  user) return the active, public catalog.
- `GET /api/account/entitlement` returns the account's effective read model.
- Web: `/plan` view (`Plan.tsx`), shared `planUi.tsx` (also used by `Usage`),
  pricing metadata in `AdminPlans`.
- Base plan = **Free**: all features enabled, hosted resources `0`, X `0`.
- `starter`/`pro`/`agency` exist as **disabled, hidden drafts** with no prices.

### 1.5 Usage ledger and platform admin

- `seo_usage_events` - append-only, immutable, RLS SELECT-only. `project_id` and
  `account_id` are `ON DELETE SET NULL` so history survives tenant deletion.
- `seo_platform_admins` - a **separate** trust boundary, RLS enabled with **no
  policies**, service-role only, populated out of band.
- `requirePlatformAdmin` (API) + `seo_assert_platform_admin` (defense in depth)
  gate `GET /api/admin/plans`,
  `POST /api/admin/accounts/:accountId/plan`,
  `GET /api/admin/accounts/:accountId/entitlement`.

### 1.6 Where billing does and does not belong

| Concern | Owner | Billing's role |
| --- | --- | --- |
| "Has this customer paid for this plan?" | Billing (Stripe) | **Authoritative.** |
| "Which plan is this account on?" | Old Skool SEO (`seo_account_entitlements`) | Billing may **feed** it. |
| "What may the plan do?" (features) | P13 entitlement | Billing must **not** compute it. |
| "How much may the plan consume?" | P14 resource policies | Billing must **not** compute it. |
| "Is this operation safe/attributable?" | P9/P11 technical protection | Billing must **not** override it. |
| "What did the account actually use?" | `seo_usage_events` | Billing must **not** rewrite it. |

**Invariant:** billing writes exactly one thing into the existing architecture -
the account's plan assignment - and only through the existing append-only
binding path. It never reads or writes feature/resource tables to enforce
anything.

## 2. Commercial Model

Four questions, four owners, never merged:

```text
billing answers:            "Has this customer commercially purchased this plan?"
entitlement answers:        "What is this plan allowed to do?"
resource policy answers:    "How much may this plan consume?"
technical protection:       "Can this operation safely execute?"
```

The commercial chain:

```text
Stripe Subscription
  -> verified billing state (our DB)
  -> account commercial plan assignment (seo_account_entitlements)
  -> P13 entitlement (features)
  -> P14 resource policies (allowances)
  -> P9/P11 technical protection
  -> provider call + usage ledger
```

No step may skip, merge or contradict the ones below it. A browser redirect, a
client-provided plan id or a client-provided price id is **never** evidence of
payment; only a signature-verified Stripe event that we persist and process is.

## 3. Account <-> Customer Model

**Cardinality (v1):**

- `seo_accounts` 1 : 1 `seo_billing_customers` (one Stripe customer).

Reasoning from the existing architecture: `seo_accounts.owner_user_id` is unique
(one user = one account), and `account_id` is already the entitlement money
boundary (`seo_account_entitlements`, `seo_resource_policies.scope='account'`,
`seo_usage_events.account_id`). The Stripe customer must attach at the same
boundary so billing, allowance and usage share one owner. Attaching at the user
or project level would fragment the boundary P13/P14/P15 established.

- `seo_accounts` 1 : N `seo_billing_subscriptions` **physically** (history
  preserved), but **at most one commercially active subscription at a time** in
  v1. The active commercial subscription selects the commercial plan.

The desired relation is:

```text
Old Skool SEO account
        ↕  (1:1, account_id is the key)
Stripe Customer
        ↓
Stripe Subscription (one active commercial subscription per account in v1)
        ↓
Commercial Plan (P15 seo_plans)
```

Not:

```text
user -> Stripe subscription -> entitlement
```

because that would bypass the account boundary and split ownership.

**Explicitly examined:**

- **Account -> Stripe customer cardinality:** 1:1. The Stripe customer id is a
  nullable unique external reference on the account (mirrored in
  `seo_billing_customers`), created lazily at first checkout.
- **Account -> subscription cardinality:** many historical rows, one active. The
  table keeps ended subscriptions (audit + grandfathered price history); only the
  active one drives the plan assignment.
- **Multiple subscriptions:** not allowed for entitlement in v1. If the product
  later needs add-ons, they attach to the same account and are resolved by
  product policy, not by stacking entitlement plans.
- **Multiple products:** one commercial plan per account in v1; add-on products
  are a future P17+ decision with their own mapping.
- **Future team/business accounts:** today one user = one account and there is
  no `seo_account_members`. A shared/business account needs an account-member
  model (billing role vs entitlement owner) before it can be sold to a company.
  **This is an open decision** (section 36); v1 sells to the account owner.
- **Account deletion:** `seo_accounts.owner_user_id` is `ON DELETE CASCADE`, so
  deleting the user deletes the account. Recommendation: account deletion must
  **not** silently leave a live Stripe subscription; a deletion flow (P17+) must
  cancel or hand off the subscription first. P16 only records the requirement.
- **Account ownership transfer:** not supported today; ownership is the unique
  `owner_user_id`. Transferring billing between accounts is out of scope; v1
  treats the account as the permanent commercial owner.

**v1 rule (recommended):**

> One Stripe customer per account, and at most one commercially active
> subscription per account. The active subscription selects the commercial plan,
> which is applied as an account plan assignment through the existing
> append-only `seo_account_entitlements` path.

## 4. Stripe Identifiers

Stripe ids are **external references**, never primary Old Skool SEO identifiers.

| Identifier | Persist | Unique | Nullable | Lifecycle | API exposure | Security |
| --- | --- | --- | --- | --- | --- | --- |
| `stripe_customer_id` | Yes (`seo_billing_customers`) | Yes | Yes until first checkout | Immutable once set | Internal only (never returned raw) | Server-only; identifies the payer |
| `stripe_subscription_id` | Yes (`seo_billing_subscriptions`) | Yes | Yes (before first sub) | Mutable (created, active, ended) | Internal only | Server-only |
| `stripe_product_id` | Yes (`seo_plan_prices`) | Per environment | No (when a price is published) | Immutable per version | Internal only | Server-only; maps plan to Stripe product |
| `stripe_price_id` | Yes (`seo_plan_prices`) | Yes (per environment) | No (when published) | Immutable (a version is never edited) | Internal only | Server-only; the subscription's price truth |
| `checkout_session_id` | Optional (billing event/audit) | No | Yes | Transient | Internal only | Server-side correlation only; never an auth signal |
| `stripe_event_id` | Yes (`seo_billing_events`) | Yes | No | Append-only | Internal only | Idempotency key; verified by signature |

Rules:

- Primary keys stay `uuid` generated by Old Skool SEO. Stripe ids are `text`
  columns with unique constraints, `NOT NULL` only when the row is meaningful.
- No Stripe id may appear in a URL path, query string or browser response.
- All Stripe id columns are service-role readable only; RLS denies browser
  access to mapping/event/subscription tables.

## 5. Plan <-> Stripe Product/Price Mapping

Two candidate models were evaluated against the P15 schema.

**Model A - Stripe ids directly on `seo_plans`.** Rejected. It cannot express
monthly + yearly + multiple currencies + price history, it conflates the
*current public display price* (P15 metadata) with the *transactional Stripe
price* (a lifetime artifact), and it would force editing a plan row to add a
price version.

**Model B - a separate price mapping layer.** Recommended.

```text
seo_plans
   ↓
seo_plan_prices        (one row per plan x interval x currency x version x env)
   ↓
Stripe product + price
```

Why Model B is more robust here:

- **Monthly/yearly** are separate Stripe prices; the mapping keys on `interval`.
- **Multiple currencies** are separate Stripe prices; the mapping keys on
  `currency`.
- **Price changes** append a new version row instead of mutating a plan.
- **Grandfathered pricing** works because a subscription stores its own Stripe
  `price_id`; the mapping row that produced it may later be retired.
- **Old/archived prices** stay as rows (`active=false`, `retired_at`) for audit.
- **Multiple Stripe environments** are separated by a `livemode` flag (or an
  environment column), so test and live never collide.

Relationship to P15: P15's `monthly_price`/`yearly_price`/`currency` remain the
**public display metadata**. `seo_plan_prices` is the **transactional mapping**.
They must agree for the current public price (P16 section 15 records this as a
follow-up risk, not a P15 redesign).

## 6. Price Versioning

```text
Plan (seo_plans)
  ↓
Price version (seo_plan_prices rows, append-only)
  ↓
Subscription (stores the exact Stripe price_id)
```

Example:

```text
pro
 ├── EUR monthly v1   (stripe_price ..., active=false, retired)
 ├── EUR monthly v2   (stripe_price ..., active=true)
 └── EUR yearly  v1   (stripe_price ..., active=true)
```

Rules:

- **A published price row is immutable.** Changing a public price means inserting
  a new version (`version = max+1`) and retiring the old one; never editing.
- **Existing subscriptions keep their Stripe `price_id`.** The customer keeps
  paying the price they bought (Stripe honor/grandfather semantics). Old
  mapping rows stay queryable even when no longer active.
- **Plan UI shows the current public price**: the active mapping row(s) for the
  plan's public display, cross-checked with P15 `monthly_price`/`currency`.
- **No hardcoded Stripe price ids in frontend code.** The frontend sends a plan
  `key`; the server resolves the active price id from `seo_plan_prices`.

## 7. Subscription State Model

Stripe states are mapped to a small internal billing state, and only the
internal state feeds entitlement.

| Stripe status | Internal billing state | Entitlement effect |
| --- | --- | --- |
| (no subscription) | `none` | Free plan (default assignment). |
| `trialing` | `trialing` | Paid plan active (subject to trial product policy). |
| `active` | `active` | Paid plan active. |
| `past_due` | `past_due` (grace) | Paid plan active during a bounded grace window; operator-funded resources may be restricted (section 20). |
| `unpaid` | `restricted` | Paid plan removed; falls back to Free. |
| `paused` | `paused` | Paid plan removed; falls back to Free (paused is not an entitlement state). |
| `canceled` | `canceled` | Paid plan removed at the effective moment; Free. |
| `incomplete` | `incomplete` | No paid plan yet (checkout not completed); Free. |
| `incomplete_expired` | `expired` | No paid plan; Free. |

Not every Stripe state needs its own Old Skool SEO state, but every Stripe state
must map deterministically to one internal state (and therefore to one
entitlement outcome). The mapping is owned by Old Skool SEO, not read from the
browser.

## 8. Entitlement Activation

`subscription.status = 'active'` is **necessary but not sufficient** to activate
a plan assignment. The activation path is:

```text
Stripe subscription
   -> signature-verified event persisted
   -> internal verified billing state (our DB)
   -> account commercial plan assignment (append-only)
   -> P13 entitlement layer resolves features/allowances
```

The billing layer **feeds** a plan assignment; it does not compute features,
allowances or admission. Practically, billing performs the same operation as
`seo_platform_admin_assign_plan`: close the current active
`seo_account_entitlements` row (`effective_to = now()`) and append a new one.

**P17 prerequisite:** factor the append-only plan switch into one shared
security-definer function (e.g. `seo_set_account_plan(p_account, p_plan,
p_assigned_by, p_reason)`) that both the admin RPC and the billing service call,
so there is exactly one code path that changes a plan. Billing passes a null/among
system actor; the account binding stays auditable.

## 9. Billing Webhook as Source of Truth

Relevant events (minimal set):

| Event | Why |
| --- | --- |
| `checkout.session.completed` | Links the checked-out Stripe customer/subscription to our account (via metadata `account_id`). |
| `customer.subscription.created` | First subscription state. |
| `customer.subscription.updated` | Plan/price change, status change, cancel-at-period-end, pause. |
| `customer.subscription.deleted` | Subscription ended -> fall back to Free. |
| `invoice.paid` | Confirms a paid period (renewal, grace resolution). |
| `invoice.payment_failed` | Starts the payment-failure/grace policy. |

Only these are needed for v1; add events only when a business effect requires
them.

Handling rules:

- **Idempotency:** keyed on `stripe_event_id` with a unique constraint; a
  processed event never re-applies.
- **Ordering:** do not trust payload order. On any subscription event, **re-fetch
  the current subscription from Stripe** (server-side) before applying state, so
  a late/duplicate event cannot resurrect an old plan. The re-fetch is
  authoritative; the webhook is the trigger.
- **Duplicates / replay:** the unique event id + terminal `processed` status make
  replays no-ops.
- **Signature verification:** every request is verified before any DB write
  (section 11).
- **Persistence:** every event is stored (section 10) before processing.
- **Retry behavior:** Stripe retries non-2xx responses; processing failures are
  recorded and retried via the existing durable job worker rather than doing
  heavy work inline.

## 10. Webhook Event Persistence

Persist events in `seo_billing_events` (section 19):

- `stripe_event_id` unique; `type`; `received_at`; `processed_at`;
  `status` (`received`/`processed`/`failed`/`ignored`); `attempts`; `error`;
  optional `account_id` once resolved.
- Store only a **minimal** payload/reference needed to reprocess; never store
  raw payment instrument data.

Goal: **exact-once business effect** even when Stripe redelivers. A webhook may
never apply a plan change twice. The plan switch itself is idempotent
(`v_current = p_plan` is a no-op today), and the event status short-circuits
reprocessing.

## 11. Webhook Security

- **Signature verification** with the Stripe webhook secret, always, before any
  side effect.
- **Raw request body** is required. The current `app.ts` uses `express.json()`
  globally; the webhook route must be mounted with `express.raw({ type:
  'application/json' })` (or use `req.rawBody`) so verification sees the exact
  bytes. Record this as a concrete P17 integration detail.
- **Endpoint authentication:** the Stripe signature *is* the authentication; the
  browser/user session is irrelevant here.
- **Replay:** unique `stripe_event_id` + timestamp tolerance.
- **Timestamp tolerance:** reject events outside Stripe's default tolerance.
- **Secret storage:** `STRIPE_WEBHOOK_SECRET` server-side only, gitignored env.
- **Environment separation:** test/live webhook secrets and endpoints never mix.
- Never do `if (req.body.subscription.status === 'active')` without
  cryptographic verification. Billing state is **never** accepted from a browser.

## 12. Checkout Architecture

Options: **Stripe Checkout** (hosted) vs **custom Payment Element**.

**Recommendation: Stripe Checkout (hosted) for v1.**

| Dimension | Stripe Checkout | Custom Payment Element |
| --- | --- | --- |
| Implementation complexity | Low (server creates a session, redirect) | High (own payment UI + PCI surface) |
| Security | Stripe-hosted, PCI scope minimal | More surface to secure |
| Experience | Consistent, localized, SCA-ready | Full control |
| Subscription upgrades | Supported via new sessions | Custom |
| Coupons / promotion codes | Built in | Custom |
| VAT / Stripe Tax | Integrated | Custom |
| Future billing portal | Natural pairing | Still usable |
| Webhook behavior | Same verified events | Same |

For v1 the server creates a Checkout Session in `subscription` mode using a
server-resolved `stripe_price_id` (never a client-provided id), attaches
`metadata.account_id`, and lets Stripe collect payment. Upgrades later can also
use Checkout. No checkout is implemented in P16.

## 13. Customer Portal

**Recommendation: enable the Stripe Customer Portal for v1**, scoped to payment
method, invoices, billing details and cancellation.

| Concern | Old Skool SEO UI | Stripe-hosted portal |
| --- | --- | --- |
| Current plan + allowances + usage | Yes (`/plan`) | No |
| Plan selection / upgrade | Yes (our catalog) | Optional |
| Payment method | Link out | Yes |
| Invoices / receipts | Link out | Yes |
| Cancellation | Link out (or own button) | Yes |
| Billing details / VAT id | Link out | Yes |

Rationale: keep the **smallest possible billing surface** in our own UI. We
already own the plan/allowance read model; payment mechanics, invoices and
cancellation belong in the portal. This also reduces PCI and compliance surface.

## 14. VAT / Tax Considerations

Old Skool SEO operates in an EU/NL context, so billing must account for:

- **VAT** on B2C sales and **reverse charge** for valid B2B EU VAT ids.
- **VAT ID collection/validation** and **billing address** for tax determination.
- **Invoice requirements** (sequential numbering, VAT breakdown) - Stripe Invoices
  can satisfy much of this.
- **Stripe Tax** can compute VAT automatically from the customer location.

**Recommendation:** use Stripe Tax (or at minimum Stripe's tax/VAT tooling) and
collect a billing address + VAT id through Checkout/Portal.

**Explicitly flagged as requiring legal/fiscal advice (do not decide in P16):**
VAT registration/OSS, invoice issuer, reverse-charge wording, KYC/consumer law,
and refund/withdrawal rules.

No fiscal implementation in P16.

## 15. Pricing and P15 Adequacy

P15's model is sufficient for **display** but insufficient for **real sale**
without a mapping layer. Findings (documented, not silently redesigned):

| P15 field | Verdict |
| --- | --- |
| `monthly_price` / `yearly_price` (minor units) | Display metadata; correct type; needs a Stripe price mapping to be chargeable. |
| `currency` | Display only; Stripe charges per price/currency; mapping must key on it. |
| `price_status` (`draft`/`final`) | Good guard against selling drafts. |
| `status` active/inactive | Good: inactive/disabled plans are never assigned. |
| `is_public` | Good: drafts stay hidden. |
| `billing_intervals` | Good: drives which price versions exist. |

What P15 **cannot** express (P16 findings):

- **Price history/versioning** - P15 stores one current price per plan.
- **Grandfathered customers** - no per-subscription price record.
- **Discontinued plans** with live subscribers - P15 has no retire-with-grace.
- **Environment separation** - no test/live distinction.
- **External price id** - no Stripe reference.

**Conclusion:** keep P15 as-is for display and add `seo_plan_prices` for the
transactional mapping in P17. A future refinement (derive public display price
from the active mapping row) is optional and must not be done silently.

## 16. Free Plan Semantics

Transitions:

```text
no subscription  ->  Free
paid canceled    ->  Free
```

Decisions:

- **Free is a real plan assignment.** An account always resolves a plan; the
  `seo_assign_default_plan` trigger binds new accounts to the default plan, and
  `EntitlementService.activePlan` falls back to the default when unbound.
- **No subscription = Free** rather than "no entitlement": absence of billing is
  represented as the base plan, so the entitlement read model never has a hole.
- **After cancellation**, the account is switched back to the base plan through
  the same append-only assignment path.
- **Free keeps its usage period** - period accounting is derived from
  `seo_usage_events` windows (`resolveAllowancePeriod`), so switching plans does
  not reset or rewrite usage. A downgrade to Free is therefore bounded by the
  same calendar window.
- **Free's `0` hosted/operator-funded allowances must not change** because of
  billing. Billing only chooses the plan; it never edits `seo_resource_policies`.
  BYOK still works on Free (byok-exempt resources).

## 17. Upgrade Semantics

Examples: Free -> Pro, Starter -> Pro, Pro -> Agency.

- **v1: upgrades are immediate.** On a verified paid event, the plan assignment
  switches immediately, so the account gets the larger entitlement without
  waiting.
- **Stripe proration** handles the money (immediate proration by default).
- **Allowance period is not reset** by an upgrade - it stays the account's
  current calendar window. Mid-period usage already counted still counts.
- **Unused allowance is not carried over** and not refunded; a plan allowance is
  a per-period cap, not a bank.
- **Downgrade scheduling** is handled in section 18.

Recommended v1 rule:

> A commercial plan change becomes entitlement-effective only at an explicitly
> defined billing moment. **Upgrades** take effect immediately (verified event);
> **downgrades** take effect at period end.

## 18. Downgrade Semantics

Downgrades are more dangerous than upgrades.

Example: Pro usage = 480, Starter allowance = 100.

- **Downgrade is scheduled for period end**, never applied instantly while the
  account is above the smaller allowance.
- **The lower allowance becomes effective on the next verified billing period
  boundary**, when the new period starts with fresh usage.
- **Already-used capacity is never deleted or manipulated** to make a downgrade
  fit (hard rule; consistent with the usage ledger's immutability).
- **Feature access** changes only at the effective moment; until then the
  existing plan remains in force.
- **Resources above the new allowance** simply stop being admitted under the
  smaller cap once it is effective; the account is not retroactively penalized.

## 19. Cancellation

**Cancel at period end (default):**

- Entitlement continues until `current_period_end`.
- At the effective end, the account switches to Free via the verified event.
- UI shows "access until <date>".
- Usage is retained.

**Cancel immediately:**

- Entitlement ends at the cancellation moment; the account switches to Free.
- Possibly exposed through the Stripe portal (with a clear warning).

**Reactivation:** before the effective end, canceling the scheduled
cancellation (or a new subscription) keeps/restores the paid plan; a new
subscription after lapse is a fresh activation.

## 20. Payment Failure

On `invoice.payment_failed`, **do not** immediately downgrade the account.
Recommended v1 policy:

- Enter a bounded **grace period** (`past_due`): the paid plan stays active.
- Resolve on the next verified event: `invoice.paid` -> back to `active`;
  Stripe's `unpaid`/subscription deletion -> switch to Free.
- During grace, optionally restrict **operator-funded** hosted resources while
  keeping the product readable (a single billing-state -> entitlement policy),
  so unpaid hosted spend cannot grow unbounded.
- No route-specific logic: the transition is one billing-state rule, not a
  per-endpoint check.

This keeps paying customers un-disrupted for transient card issues while
bounding operator cost, and is fully reversible by the next `invoice.paid`.

## 21. Resource Economics

Re-check P10/P12/P14 from a billing perspective for AI text, AI image,
DataForSEO and X link posts. Q16 builds **no cost accounting**; it only records
the data later needed to set prices and margin.

| Quantity | Source today | Needed later |
| --- | --- | --- |
| Customer allowance | `seo_resource_policies.allowance` | Already exists. |
| Provider usage | `seo_usage_events` (quantity/unit/category) | Already exists. |
| Funding source | `seo_usage_events.funding_source` | Already exists. |
| Provider cost | Not stored | Future cost table / rate card. |
| Customer price | P15 metadata + `seo_plan_prices` | Mapping added in P17. |
| Gross margin | Derived | Future = price - provider cost. |

The one resource with an unambiguous per-unit operator cost (X link post) is
already isolated (`x_link_post`). Before prices are finalized, the open question
is whether the **concrete paid-tier allowances** (currently `null`/draft) leave
enough margin after provider cost.

## 22. BYOK Semantics

BYOK must stay outside the billing allowance exactly where P13/P14 says so.

| Case | Feature entitlement | Resource allowance | Operator cost |
| --- | --- | --- | --- |
| Paid + hosted AI | Plan features | Consumes hosted allowance | Yes |
| Paid + BYOK AI | Plan features | **No** hosted consumption (byok-exempt) | No |
| Free + BYOK | Default plan features | **No** hosted consumption | No |

- Billing assigns the plan; it must not reclassify BYOK usage as hosted.
- Funding attribution stays in P14 (`resolveFunding`, `funding.ts`); billing
  never writes `funding_source`.
- Connecting a key remains an account/project credential concern, not a billing
  one.

## 23. API / MCP

Paid accounts behave identically across REST, MCP, worker, schedules and
publishing:

```text
billing -> plan assignment -> P13 entitlement -> existing admission
```

- **No browser billing check** is required before API/MCP can work. The service
  layer admits via the same `withAdmission` path regardless of caller.
- The MCP server must never read Postgres/billing directly; it calls the same
  SEO Core services (architecture invariant).
- An expired/failed subscription is reflected by the plan assignment, so the
  entitlement layer naturally lowers the limits; there is no separate
  billing gate in the request path.

## 24. Admin Model

Future admin surface distinguishes two things:

**Commercial state (read-only):**

- billing status; current plan; Stripe customer/subscription references;
- internal billing state; price; renewal/end date; payment failure flag.

**Manual entitlement override (explicit + audited):**

- an operator may move an account onto a plan via the existing
  `seo_platform_admin_assign_plan` (writes `assigned_by`), not by editing Stripe
  ids or pricing fields.

An admin must not be able to bypass the technical entitlement architecture from a
billing screen. Audit logging: every override keeps `assigned_by`; add a
`reason` when the shared plan-switch function lands (P17).

## 25. Manual / Admin Override

v1 needs a manual override for free Pro accounts, comped customers, support
extensions and lifetime customers.

**Recommended v1:** use the existing append-only plan assignment as the override
mechanism (it is already audited by `assigned_by`, already keeps history, and
already drives entitlement). Do **not** fake Stripe ids, prices or subscription
statuses.

A billing subscription (if any) and a manual override can coexist; the **effective
plan** is whichever the assignment layer currently holds. A future dedicated
override table with an expiry/reason is a P17+ option, not required for v1.

## 26. Multi-Environment

Strict separation of `development` / `staging` / `production`:

- **Price/product ids per environment** live in environment-scoped mapping rows
  (`livemode` flag or an environment column).
- **Webhook endpoints** are distinct per environment with distinct secrets.
- **Secrets** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) are server-side,
  gitignored, and never shared between test and live.
- **Test customers** stay in test mode; live data is never copied into seeds.
- **Migration/seed strategy:** seeds never contain production Stripe ids.

## 27. Proposed Database Model

No migration in P16; this is the P17 proposal. All tables are `seo_*`, RLS
enabled, browser access denied (service-role via API DTOs), and use `account_id`
as the ownership boundary.

### `seo_billing_customers`

- **Purpose:** map an account to its Stripe customer.
- **PK:** `id uuid`.
- **FK:** `account_id` -> `seo_accounts(id)` `ON DELETE CASCADE`, **unique**.
- **Unique:** `stripe_customer_id`.
- **Columns:** `account_id`, `stripe_customer_id`, `livemode bool`, `created_at`.
- **Immutable:** `account_id`, `stripe_customer_id`, `livemode`. **Mutable:** none.
- **RLS:** no browser policy (service-role only); optional owner SELECT later
  through a DTO.

### `seo_billing_subscriptions`

- **Purpose:** current + historical subscription state per account.
- **PK:** `id uuid`.
- **FK:** `account_id` -> `seo_accounts(id)` `ON DELETE CASCADE`.
- **Unique:** `stripe_subscription_id`.
- **Columns:** `account_id`, `stripe_subscription_id`, `stripe_customer_id`,
  `stripe_price_id`, `status`, `internal_state`, `interval`, `currency`,
  `current_period_start`, `current_period_end`, `cancel_at_period_end`,
  `canceled_at`, `ended_at`, `livemode`, `created_at`, `updated_at`.
- **Mutable:** `status`, `internal_state`, period dates, cancel flags.
- **Immutable:** ids, `livemode`, `created_at`.
- **RLS:** service-role only.

### `seo_billing_events`

- **Purpose:** idempotent, replay-safe webhook event log.
- **PK:** `id uuid`. **Unique:** `stripe_event_id`.
- **FK:** optional `account_id` -> `seo_accounts(id)` `ON DELETE SET NULL`.
- **Columns:** `stripe_event_id`, `type`, `received_at`, `processed_at`,
  `status`, `attempts`, `error`, `account_id`, `payload jsonb`.
- **Mutable:** processing fields only. **Immutable:** `stripe_event_id`, `type`,
  `payload`, `received_at`.
- **RLS:** service-role only.

### `seo_plan_prices`

- **Purpose:** transactional plan -> Stripe product/price mapping with versioning.
- **PK:** `id uuid`.
- **FK:** `plan_id` -> `seo_plans(id)` `ON DELETE RESTRICT`.
- **Unique:** `stripe_price_id`; and `(plan_id, interval, currency, version,
  livemode)`.
- **Columns:** `plan_id`, `interval` (`monthly`/`yearly`), `currency`,
  `stripe_product_id`, `stripe_price_id`, `unit_amount` (minor units),
  `version`, `active`, `livemode`, `effective_from`, `retired_at`, `created_at`.
- **Mutable:** `active`, `retired_at`. **Immutable:** everything else.
- **RLS:** service-role only.

## 28. Proposed API Model

Documented, not implemented:

| Endpoint | Purpose | Needed v1? |
| --- | --- | --- |
| `GET /api/billing` | Account billing read model (plan, billing state, renewal, price display). | Yes |
| `POST /api/billing/checkout` | Create a Checkout Session for a plan key. | Yes |
| `POST /api/billing/portal` | Create a Customer Portal session. | Yes |
| `POST /api/billing/webhook` | Stripe webhook (raw body + signature). | Yes |
| `POST /api/billing/cancel` | Request cancellation. | Optional (portal covers it) |
| `POST /api/billing/resume` | Undo scheduled cancellation. | Optional (portal covers it) |

Avoid CRUD over Stripe objects. All mutations resolve the account from the
session and the price from `seo_plan_prices`; no client-provided plan/price id is
ever authorization.

## 29. Source-of-Truth Matrix

| Data | Source of truth |
| --- | --- |
| Customer account | Old Skool SEO (`seo_accounts`) |
| Product plan | Old Skool SEO (`seo_plans`) |
| Feature entitlement | Old Skool SEO (`seo_plan_features` / P13) |
| Resource allowance | Old Skool SEO (`seo_resource_policies` / P14) |
| Usage | Old Skool SEO (`seo_usage_events`) |
| Stripe customer ID | Old Skool SEO reference + Stripe |
| Subscription status | Stripe (mirrored, verified, into our billing state) |
| Price ID | Stripe (referenced by `seo_plan_prices`) |
| Payment status | Stripe |
| Billing event authenticity | Stripe signature |
| Effective entitlement | Old Skool SEO |

## 30. Failure and Consistency Model

The architecture must tolerate **eventually consistent billing state**. Never use
a browser redirect as proof of payment.

| Scenario | Behavior |
| --- | --- |
| Webhook delayed | The account keeps its last verified state; checkout success alone does not activate. Eventually the event arrives. |
| Duplicate webhook | Unique `stripe_event_id` + `processed` status -> no second effect. |
| Out-of-order events | Re-fetch current subscription from Stripe before applying; latest truth wins. |
| Stripe temporarily unreachable | Webhook processing fails, is recorded, and is retried by the durable worker; state stays at last verified value. |
| DB write fails | Transaction rolls back; event stays unprocessed and is retried. |
| Entitlement update fails | Same transaction as the plan switch; if it fails, the event is retried. |
| Checkout succeeded, webhook not processed | Account not yet upgraded; UI shows a "processing payment" state, then reconciles on `checkout.session.completed`. |
| Webhook processed, frontend cached stale | Frontend re-reads `GET /api/account/entitlement` / `GET /api/billing`; server is authoritative. |

## 31. Security Model

- Stripe secret keys **server-side only**; never in the frontend bundle.
- Webhook secrets server-side; signature verification always.
- No Stripe secret in the frontend, ever.
- No client-provided **plan id** as authorization.
- No client-provided **price id** as entitlement proof.
- Account ownership resolved **server-side** from the session
  (`requireAccount`), never from the request body.
- Webhook signature verification + timestamp tolerance.
- Idempotency on `stripe_event_id`.
- Admin boundary via `requirePlatformAdmin` + `seo_assert_platform_admin`.
- RLS on all billing tables; service-role access only.
- Billing state is never accepted from a browser.

## 32. Observability

Log (without payment data):

- webhook received / verified / processed / duplicate / failed;
- subscription state transition (from -> to);
- plan assignment transition;
- checkout session created;
- billing inconsistency (e.g. subscription active but no price mapping).

Never log: card data, full Stripe payloads containing payment details, secrets,
tokens. Store only the minimal payload needed to reprocess.

## 33. Testing Strategy

**Webhook:** valid signature; invalid signature; duplicate event; out-of-order
event; replay; failed processing + retry.

**Subscription:** created; activated; upgraded; downgraded; canceled; payment
failure; restored.

**Plan:** subscription -> correct P15 plan; inactive plan rejected; archived
price still valid for an existing subscription.

**Entitlement:** billing state feeds P13; P14 allowance unchanged; BYOK
unchanged; Free remains `0` hosted resources.

**Security:** account isolation; user cannot self-upgrade; user cannot forge a
webhook; user cannot choose another account's plan or price.

## 34. Stripe Recommendation

| Component | Decision |
| --- | --- |
| Stripe Checkout | **RECOMMENDED** for v1 (hosted, minimal PCI surface). |
| Stripe Customer Portal | **RECOMMENDED** for payment method, invoices, billing details, cancellation. |
| Stripe Billing (subscriptions) | **RECOMMENDED** (the subscription/price model). |
| Stripe Tax | **RECOMMENDED** (or Stripe tax tooling); VAT policy needs fiscal advice. |
| Webhook architecture | **RECOMMENDED** (verified, persisted, idempotent, re-fetch on subscription events). |
| Price/product mapping | **RECOMMENDED** Model B (`seo_plan_prices`, versioned). |
| Subscription model | **RECOMMENDED** one active commercial subscription per account; upgrades immediate, downgrades at period end. |

## 35. Deliverable

This document: `docs/p16-commercial-billing-stripe-recon.md`.

## 36. Product Decisions (must be finalized before P17)

### 36.1 Decided

Locked on 2026-10-07. These constrain all later pricing and all P17 work.

**A. Billing scope - account-level (DECIDED).**

> Plans, pricing, subscriptions and hosted resource allowances are
> account-scoped. Projects consume the account's entitlements but do not have
> their own commercial plan.

One commercial plan per account; never one subscription per project. This
matches the schema as built (sections 1.1 and 1.2): `seo_account_entitlements`
and `seo_entitlement_reservations` are keyed by `account_id` (with a nullable
`project_id` used only for attribution), so entitlements already resolve at
account scope. A per-project subscription would fight this model.

**B. Free plan definition (DECIDED).**

> Free is EUR 0 with **zero** operator-funded hosted resources (AI generation,
> AI images, DataForSEO research, media). It is a usable product environment,
> not a free sample of paid capacity.

Free still provides: account and projects, Google integrations, bring-your-own
keys (BYOK) / user-funded functionality, and read access to the account's own
data. It does **not** gift operator-funded AI, DataForSEO or X link posts. This
matches the P15 base plan (hosted resource policies = 0) and keeps unit
economics clean from day one. BYOK stays exempt from hosted allowances.

**C. Paid-tier positioning (DECIDED).**

> Starter / Pro / Agency are ascending **SEO-capacity levels** of the platform,
> not credit-bucket SKUs.

- Starter - for one operator/site, limited hosted automation.
- Pro - for serious daily SEO work: multiple projects, wider research and
  content capacity.
- Agency - for multiple clients/sites: higher automation and publishing
  capacity, larger allowances.

The tiers describe capability. Concrete numeric allowances and prices are
attached afterwards (36.2 and 36.4); a tier is not a fixed credit count.

**D. Agency topology (DECIDED).**

> Account = the commercial customer/organization. One account can hold multiple
> projects/sites. End clients are not required to have their own Old Skool SEO
> account.

- Billing stays account-level; every project under the account shares the plan
  capacity. `project_id` remains attribution; `account_id` remains the
  entitlement and billing boundary.
- `seo_account_members` becomes relevant once several people inside one account
  must work together; adding staff or end clients later does not change the
  billing model.
- To stop an agency from placing unlimited clients for one price, project/site
  count can later become its own plan entitlement/resource.

**E. API/MCP availability (DECIDED).**

> REST API and MCP are available on every tier, including Free. They are
> interfaces to the product, not a metered resource by themselves. Consumption
> through them is enforced by the same P13/P14 entitlement engine and resource
> admission, so Free can automate a BYOK workflow via API/MCP but cannot open an
> operator-funded AI/DataForSEO/X tap. Any future API/MCP rate limits are a
> separate resource policy, not a reason to gate API behind Pro/Agency.

### 36.2 Still Open

| Decision | Status |
| --- | --- |
| Definitive plan prices | **UNKNOWN** |
| Monthly/yearly pricing | **UNKNOWN** |
| Definitive paid-tier allowances | **UNKNOWN** |
| Trial yes/no (and length) | **UNKNOWN** |
| Upgrade timing | **RECOMMENDED** (immediate) |
| Downgrade timing | **RECOMMENDED** (period end) |
| Cancellation timing | **RECOMMENDED** (period end default) |
| Payment failure / grace period length | **RECOMMENDED** (bounded grace; exact duration UNKNOWN) |
| VAT/tax policy | **UNKNOWN** (needs fiscal advice) |
| Checkout flow | **RECOMMENDED** (Stripe Checkout) |
| Customer portal scope | **RECOMMENDED** (payment method, invoices, cancel) |
| Discounts / promotions | **UNKNOWN** |
| Manual beta/customer overrides | **RECOMMENDED** (existing plan assignment; dedicated table deferred) |
| Shared/business accounts (account members) | **UNKNOWN** (topology decided in D; `seo_account_members` not built yet) |
| Price display source (P15 metadata vs mapping) | **RECOMMENDED** (P15 for display; mapping for charge) |
| Project-count limits per tier | **UNKNOWN** (candidate plan entitlement/resource, see D) |
| API/MCP rate limits per tier | **UNKNOWN** (separate future resource policy, see E) |

### 36.3 Decision Notes

- A/B/C are foundational: they fix billing scope, the free boundary and tier
  meaning. The first three rows of 36.2 (prices, billing interval, allowances)
  depend on them and must be derived from unit economics, not guessed.
- D pins the agency/organization shape (one account, many projects) and E pins
  API/MCP as interfaces available on all tiers; both follow from A.
- None of A/B/C/D/E needs a schema change; all are consistent with P13/P14/P15
  as built.
- BYOK stays outside hosted allowances (section 22), so paid tiers meter only
  operator-funded capacity.

### 36.4 Pricing and Allowance Matrix (to be filled once unit costs are known)

Interface availability (decided, D/E):

| Capability | Free | Starter | Pro | Agency |
| --- | --- | --- | --- | --- |
| Web UI | yes | yes | yes | yes |
| REST API | yes | yes | yes | yes |
| MCP | yes | yes | yes | yes |

Hosted operator-funded resources (numeric values still UNKNOWN):

| | Free | Starter | Pro | Agency |
| --- | --- | --- | --- | --- |
| Price / month | EUR 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| AI text | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| AI images | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| DataForSEO | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| X link posts | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| Projects | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

Project count is a candidate plan entitlement/resource (D). No value is set yet.

### 36.5 Unit Economics Worksheet (draft - inputs required)

Purpose: derive the 36.4 numbers from real vendor costs instead of guessing.
This is a working sheet: it fixes the method and the input slots, not final
prices or allowances. The parameters below are working hypotheses, not product
decisions, and may be revised as evidence appears.

Per-resource basis:

```text
provider_cost_per_unit
  x safety_factor          = safe_cost_per_unit
  x allowance_units        = worst_case_cost_per_period
  x expected_utilization   = expected_cost_per_period

plan_price_per_period - expected_cost_per_period = gross_margin
```

Definitions:

- `provider_cost_per_unit` - raw vendor price for one metered unit (below).
- `safety_factor` - covers retries, waste, vendor price drift, FX and refunds.
  Working hypothesis: 1.30.
- `allowance_units` - included units per plan per period (36.4; not set yet).
- `expected_utilization` - share of the allowance a typical customer actually
  consumes; an allowance is a ceiling, not an average. Working hypothesis: 0.40.
- margin floor - working hypothesis: 70 percent at expected utilization. This is
  a target to test, not a hard constraint: if a feature cannot reach it at a sane
  volume, that is a finding, not a reason to back-fit the allowance.

Vendor-neutral status rule (P16.2). Every rate carries one of:

```text
VERIFIED_OFFICIAL               official provider pricing or documentation
VERIFIED_REPOSITORY             established from this repository's code/config
PUBLIC_PRE_CONTRACT             public list price, not our contract rate
UNVERIFIED_PLANNING_ASSUMPTION  P16 planning number, not vendor-verified
UNKNOWN                         not determinable without contract/account data
```

No invented rate: `UNKNOWN / NEEDS CONTRACT RATE` is preferred over a guess.
Native provider currency is kept here; EUR normalization is an explicit later
step (36.5.4).

Metered units by resource bucket. The provider/mode column is the verified
repository mapping (36.5.2). `dataforseo_research` deliberately sums only
`request` and `serp_request`; raw `keyword` / `task` facts are observation only
and are not billed.

| Resource bucket | Entitlement resource | Metered unit(s) | Funding | Provider / mode (code) |
| --- | --- | --- | --- | --- |
| AI text | `ai_generation` | `input_token` + `output_token` | BYOK or operator | OpenAI chat/generate (`OPENAI_CHAT_MODEL`) |
| AI images | `ai_image` | `image_generation` | BYOK or operator | OpenAI images (`openai_media`, default `dall-e-3`) |
| DataForSEO | `dataforseo_research` | `request` + `serp_request` | operator (BYOK where supported) | DataForSEO Labs `/live` (`request`); SERP live + task (`serp_request`) |
| Stock media | `media` | `request` | operator | Unsplash `search/photos` (`media_search`) |
| X link post | `x_link_post` | `publish_attempt` (link only) | operator (never BYOK) | X API v2 `POST /2/tweets` |
| Operator background work | `background_job` | `job` | operator | platform worker |

#### 36.5.1 Verified provider-rate findings

Verified 2026-10-07. Native currency per provider.

| Resource | Rate | Currency | Source | Status |
| --- | ---: | --- | --- | --- |
| AI text input, `gpt-5-mini` | 0.25 / 1M | USD | OpenAI pricing | VERIFIED_OFFICIAL |
| AI text output, `gpt-5-mini` | 2.00 / 1M | USD | OpenAI pricing | VERIFIED_OFFICIAL |
| AI text cached input, `gpt-5-mini` | 0.025 / 1M | USD | OpenAI pricing | VERIFIED_OFFICIAL |
| AI text input, repo default `gpt-4o-mini` | 0.15 / 1M | USD | OpenAI pricing | VERIFIED_OFFICIAL |
| AI text output, repo default `gpt-4o-mini` | 0.60 / 1M | USD | OpenAI pricing | VERIFIED_OFFICIAL |
| Embedding, repo default `text-embedding-3-small` | 0.02 / 1M | USD | OpenAI pricing | VERIFIED_OFFICIAL |
| Operator text model actually selected | `OPENAI_CHAT_MODEL` (default `gpt-4o-mini`) | - | repo `providers/ai/openai.ts` | VERIFIED_REPOSITORY |
| AI image tokens, `gpt-image-1.5` (example) | 8.00 in / 32.00 out / 1M | USD | OpenAI pricing | VERIFIED_OFFICIAL |
| AI image per image, repo default `dall-e-3` | UNKNOWN / NEEDS CONTRACT RATE | - | OpenAI pricing (not listed) | UNKNOWN |
| AI image planning (average / HQ) | 0.05 / 0.10 | not stated | P16 planning | UNVERIFIED_PLANNING_ASSUMPTION |
| Repo image default model | `dall-e-3` | - | repo `providers/media/openaiMedia.ts` | VERIFIED_REPOSITORY |
| DataForSEO SERP standard | UNKNOWN / NEEDS CONTRACT RATE | USD | DataForSEO (403 / login) | UNKNOWN |
| DataForSEO SERP live | UNKNOWN / NEEDS CONTRACT RATE | USD | DataForSEO (403 / login) | UNKNOWN |
| DataForSEO Labs task / item | UNKNOWN / NEEDS CONTRACT RATE | USD | DataForSEO (403 / login) | UNKNOWN |
| DataForSEO usage vocabulary | `request` = Labs live; `serp_request` = SERP (live + task) | - | repo adapters | VERIFIED_REPOSITORY |
| Supabase storage | 0.0213 / GB | USD | Supabase pricing | VERIFIED_OFFICIAL |
| Supabase cached egress | 0.03 / GB | USD | Supabase pricing | VERIFIED_OFFICIAL |
| Supabase uncached egress | 0.09 / GB | USD | Supabase pricing | VERIFIED_OFFICIAL |
| Supabase image transformations | not used (excluded) | - | repo `infra/mediaStorage.ts` | VERIFIED_REPOSITORY |
| Stock media search, Unsplash | 0.00 / request | USD | Unsplash docs | VERIFIED_OFFICIAL |
| X post without link | 0.01 | EUR | P16 planning (no public rate) | UNVERIFIED_PLANNING_ASSUMPTION |
| X link post | 0.20 | EUR | P16 planning (no public rate) | UNVERIFIED_PLANNING_ASSUMPTION / NEEDS CONTRACT RATE |

AI text (OpenAI). The planning assumption (gpt-5-mini, USD 0.25 in / 2.00 out
per 1M) is confirmed against the official OpenAI price list. The repository
defaults to `gpt-4o-mini` (`OPENAI_CHAT_MODEL`); the operator-chosen model only
takes effect once that env var is set, so the billed rate is
`OPENAI_CHAT_MODEL`'s, not an assumption. `usageInstrumentation` records one
`input_token` / `output_token` pair per real call from the provider's own
`usage` block, so economics can price tokens directly. Embeddings default to
`text-embedding-3-small` (USD 0.02 / 1M) under the same server key; embedding is
not an operator entitlement resource, so if AI is operator-funded it is a small
uncapped cost to keep in view. Batch mode (gpt-5-mini 0.125 / 1.00) is not used.

AI images (OpenAI). Generation runs through `openai_media` with a default model
of `dall-e-3`. Current OpenAI image models are token-priced (no flat per-image
list) and `dall-e-3` is absent from the current price list, so there is no
verified per-image vendor rate to attach. The 0.05 / 0.10 figures remain
planning inputs only (`UNVERIFIED_PLANNING_ASSUMPTION`) and must not be shown as
verified cost. The metered unit is `image_generation` (one generated image).

DataForSEO. The official pricing page is not machine-readable (HTTP 403 /
login-gated) and the public docs do not publish rates, so no DataForSEO rate is
`VERIFIED_OFFICIAL`. Every seeded number is retained only as
`UNVERIFIED_PLANNING_ASSUMPTION`; the authoritative source is our contract rate
card (`NEEDS CONTRACT RATE`). The repository mapping is verified (36.5.2): the
`request` unit comes from DataForSEO Labs `/live` endpoints, and the
`serp_request` unit comes from both the SERP live endpoint and the SERP standard
task queue. Priority, screenshot, ai_summary, OnPage, Keywords Data, Backlinks,
Content Analysis, Domain Analytics, Business Data, Merchant and App Data are not
used by this repository, so their seeded rows do not affect current marginal
cost. A 50.00 USD minimum deposit and 1.00 USD trial credit are account/deposit
constraints, not marginal cost (36.5.3).

Stock media and storage. Stock-media search (Unsplash, metered as `media`) is a
free API: no per-request vendor fee, only a production rate limit (1000/hour)
and mandatory attribution (`VERIFIED_OFFICIAL`). Supabase Storage is an
infrastructure cost, not a per-account entitlement resource: storage 0.0213/GB,
cached egress 0.03/GB and uncached egress 0.09/GB are official (Pro tiers,
beyond the included 100 GB / 250 GB). Media is served through plain public
objects (`getPublicUrl`); no `/render/image` transform call exists
repository-wide, so the 5.00 / 1000 image-transform rate is excluded. Whether
public object traffic actually bills as *cached* egress is a CDN/platform
behavior and remains `UNKNOWN` at the worksheet level.

X. The publisher uses X API v2 `POST /2/tweets`; the link/non-link split is
detected in code (`/https?:\/\/\S+/i`) and a link post runs through the
`x_link_post` admission. X's public developer tiers do not publish a per-post
rate, so 0.01 (no link) and 0.20 (link) are P16 planning assumptions, not a
public or contract rate: `PUBLIC / CONTRACT RATE REQUIRED`. There is no plan or
per-post configuration in the repository.

#### 36.5.2 Code-grounded provider mappings

DataForSEO: product action -> adapter -> endpoint -> mode -> billable unit.

| Product action | Internal usage | Provider endpoint | Mode | Billable unit |
| --- | --- | --- | --- | --- |
| Keyword suggestions | `request` x1 (+`keyword` xN) | Labs `keyword_suggestions/live` | live | Labs task (one provider call per seed) |
| Related keywords | `request` x1 | Labs `related_keywords/live` | live | Labs task |
| Keyword ideas | `request` x1 | Labs `keyword_ideas/live` | live | Labs task |
| Competitor discovery | `request` x1 | Labs `competitors_domain/live` | live | Labs task |
| Competitor keyword gaps | `request` xN | Labs `domain_intersection/live` | live | Labs task per competitor |
| Interactive SERP / SERP competitors | `serp_request` xN | SERP `serp/google/organic/live/regular` | live | SERP per keyword |
| Bulk rank SERP | `serp_request` xN (+`task`/`keyword`) | SERP `task_post` -> `task_get/regular` | standard queue | SERP per keyword/task |

`serp_request` therefore blends two vendor modes (live and standard) under one
entitlement unit; a single blended rate would hide that. `request` currently maps
to Labs `/live` only.

Other resources:

| Resource | Product action | Code seam | Metered fact |
| --- | --- | --- | --- |
| AI text | chat / generate | `instrumentAiProvider` -> `AIService.resolve` | `input_token` + `output_token` |
| AI image | generate | `mediaUsage` `image_generate` (`openai_media`) | `image_generation` |
| Stock media | search | `mediaUsage` `media_search` (Unsplash) | `request` |
| X link post | publish | X publisher link predicate -> `x_link_post` admission | `publish_attempt` (link) |

#### 36.5.3 Metering vs provider billing (findings)

- `researchKeywords` loops one `keyword_suggestions/live` provider call per seed
  (up to 20) but records a single `request` fact for the whole logical operation,
  so the ledger understates Labs calls for keyword-suggestion sweeps. Economics
  must not equate one `request` to one provider call here.
- `task` facts on `fetchTaskSerp` count client HTTP batches (50 keywords per
  post), not vendor tasks; the billable count is `serp_request` (one per
  keyword). `keyword` facts are likewise observational.
- `serp_request` mixes live and standard modes, which carry different vendor
  prices.
- `keywordDifficulties` (Labs `keyword_difficulty/live`) exists in the client
  but is never called, so it bills nothing today.
- Google (`gsc`/`ga4`/`ads`) is quota-limited, not per-request priced; keep it
  separate from DataForSEO pricing.
- A DataForSEO minimum deposit (e.g. 50.00 USD) and trial credit are
  account/deposit constraints, never cost per usage period.
- BYOK consumption is excluded from hosted allowances (section 22): the operator
  cost basis applies only to `operator_funded` usage. Free has zero
  operator-funded allowance, so its expected provider cost is EUR 0.

#### 36.5.4 Currency normalization

Keep native currencies in this worksheet: OpenAI USD, DataForSEO USD, Supabase
USD, X EUR. EUR normalization happens only at 36.4, with an explicit planning FX
assumption recorded alongside it (never presented as a provider rate):

```text
FX_USD_EUR = <planning assumption; set explicitly when 36.4 is filled>
FX date/source = <record at 36.4>
```

Remaining inputs before 36.4 can be filled:

1. AI images: choose an operator image model (a current `gpt-image-*`, since
   `dall-e-3` is unlisted), then derive per-image cost from token usage; the
   0.05 / 0.10 figures stay unverified planning inputs until then.
2. DataForSEO: obtain the contract rate card and set actual per-SERP and
   per-Labs rates; decide whether `serp_request` is priced as a live/standard
   blend.
3. X: obtain the current X API plan's per-post economics for link vs non-link.
4. Supabase: decide whether public-object traffic bills as cached egress.
5. Revisit `safety_factor`, `expected_utilization` and margin floor (working
   hypotheses 1.30 / 0.40 / 70 percent) if better evidence appears.

Do not silently decide commercially meaningful choices.

### 36.6 Unit Economics Model

Purpose: turn the rates fixed in 36.5 into a cost basis that P16.4 can price
against. This is a calculation layer on top of 36.5, not a second rate recon.
36.5.1-36.5.4 stay intact as the provider-rate source.

Economics rules applied here (from 36.5, restated so 36.6 is self-contained):

- `effective unit cost = provider_cost_per_unit x safety_factor`.
- `expected period cost = allowance_units x provider_cost_per_unit x utilization x safety_factor`.
- An allowance is a ceiling, never a historical average.
- Unknown rates stay labelled; they are scenario inputs, not facts.

Three units are kept strictly apart:

| Unit | Definition | Example |
| --- | --- | --- |
| Provider unit | What the vendor actually bills | 1M input tokens; 1 image; 1 DataForSEO provider task; 1 GB egress; 1 X post |
| Internal metering unit | What `seo_usage_events` records | `ai_generation` / `input_token`; `ai_image` / `image_generation`; `dataforseo_research` / `request`; `x_link_post` / `publish_attempt`; `media` / `request` |
| Product unit | What the customer experiences as capacity | AI article; keyword research; competitor research; AI image; X post; X link post; media asset |

These are not interchangeable. In particular an internal `request` is not one
provider call (36.5.3), and one "AI article" is not one AI call (36.6.1).

All model parameters below are **economics modelling assumptions, not product
rules**. They are candidates to be revised in P16.4, not plan decisions.

#### 36.6.1 Cost basis

**Production text cost basis.** The repository default `OPENAI_CHAT_MODEL` is
`gpt-4o-mini` (`VERIFIED_REPOSITORY`), so the only current production basis is
the verified official rate USD 0.15 / 1M input and USD 0.60 / 1M output. A
`gpt-5-mini` scenario (0.25 / 2.00, plus cached 0.025) stays a *future option*
only; it is **not** the current production cost basis and is not used to price
anything here.

FX (explicit planning assumption, not a provider price):

```text
FX_USD_EUR = 0.92   (planning assumption, 2026-10-07)
planning FX only; native provider currency is preserved everywhere above
```

**Known vs unknown inputs.**

| Input | Value | Currency | Status |
| --- | ---: | --- | --- |
| OpenAI text in/out (`gpt-4o-mini`) | 0.15 / 0.60 per 1M | USD | VERIFIED_OFFICIAL |
| Supabase storage / cached egress / egress | 0.0213 / 0.03 / 0.09 per GB | USD | VERIFIED_OFFICIAL |
| Unsplash search | 0.00 | USD | VERIFIED_OFFICIAL |
| DataForSEO SERP / Labs | UNKNOWN | USD | UNKNOWN (scenario only) |
| AI image per image | UNKNOWN (0.05 / 0.10 scenario) | - | UNVERIFIED_PLANNING_ASSUMPTION |
| X non-link / link post | 0.01 / 0.20 | EUR | UNVERIFIED_PLANNING_ASSUMPTION |

**DataForSEO internal-metering distortion (36.5.3), and its economics treatment.**

| Internal event | Actual provider relationship | Economics treatment |
| --- | --- | --- |
| `request` | one Labs `/live` call per seed; `researchKeywords` loops up to 20 seeds but records one `request` | provider-call-count model (1..20), never 1:1 |
| `serp_request` | one SERP call per keyword, blending live + standard modes | endpoint/mode model, not a single blended rate |
| `task` | client HTTP batch (up to 50 keywords per post), not a vendor task | do not bill directly |
| `keyword` / `item` | observational result rows | bill only if the vendor bills per item |
| `image_generation` | one generated image | 1:1 with the vendor image unit |
| `publish_attempt` (link) | one X `POST /2/tweets` | 1:1 with the vendor post unit |

Consequence: `COUNT(seo_usage_events)` on `request` must **not** be read as a
provider bill while provider-call cardinality is not one-to-one. Economics uses
an explicit call-count scenario for DataForSEO.

**OpenAI token economics (`gpt-4o-mini`).** Raw and safe cost by generation size:

| Scenario | Input tokens | Output tokens | Raw USD | Safe @1.15 | Safe @1.30 | Safe @1.50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 10,000 | 2,000 | 0.002700 | 0.003105 | 0.003510 | 0.004050 |
| medium | 25,000 | 5,000 | 0.006750 | 0.007763 | 0.008775 | 0.010125 |
| large | 50,000 | 10,000 | 0.013500 | 0.015525 | 0.017550 | 0.020250 |

Embeddings (`text-embedding-3-small`, USD 0.02 / 1M) are not an operator
entitlement resource; a full 1M-token corpus is USD 0.02. If AI is
operator-funded this is a small uncapped cost to keep in view, priced directly
from prompt tokens (`embeddingUsage` counts physical `POST /embeddings` calls).

**AI article is multiple calls (code-grounded).** The writer never generates an
article in one call:

- Quick Draft (`graph.writeSections`): 1 planning call + 1 section call per
  approved section; the review step is deterministic (no AI). An optional
  human-requested revision adds 1 call per selected section.
- Deep Write (`runDeepWriteGeneration`): 1 architecture call + 1 section-plan
  call per section + 1 paragraph call per paragraph + up to 8 refinement calls
  + 1 coherence call, hard-capped at 90 calls (`WRITER_DEEP_MAX_TOTAL_LLM_CALLS`).
- Call/output ceilings (`VERIFIED_REPOSITORY`): plan 2000 output tokens,
  section 1500, revision 1500, deep paragraph 900, deep section-plan 700;
  plan holds 1..12 sections.

Per-call token *distribution* is not measured in the repository, so the article
scenarios below use labelled per-call token assumptions
(`UNVERIFIED_PLANNING_ASSUMPTION`); the call *structure* is verified.

| Article scenario | Mode (code) | Model calls | Input tokens | Output tokens | Raw USD | Safe @1.30 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| article-small | Quick Draft, 3 sections | 1 + 3 = 4 | 15,000 | 5,100 | 0.005310 | 0.006903 |
| article-medium | Quick Draft, 6 sections | 1 + 6 = 7 | 24,000 | 8,700 | 0.008820 | 0.011466 |
| article-large | Quick Draft, 12 sections | 1 + 12 = 13 | 42,000 | 15,900 | 0.015840 | 0.020592 |
| article-medium-deep | Deep Write, 6 sections x 3 paragraphs | 1 + 6 + 18 + 8 + 1 = 34 | 81,000 | 18,100 | 0.023010 | 0.029913 |

Token assumptions per call (planning): plan 6k in / 1.5k out; section 3k in /
1.2k out; deep section-plan 2.5k in / 0.5k out; deep paragraph 2k in / 0.5k out;
deep refinement 2.5k in / 0.5k out; coherence 4k in / 0.6k out. These are not
historical averages and must not be published as such.

#### 36.6.2 Product-unit economics

Per product unit, with raw and safe (safety 1.30) cost where defensible.
`provider` = the vendor that bills; `driver` = what scales the cost.

| Product unit | Provider | Cost driver | Raw | Safe @1.30 | Confidence |
| --- | --- | --- | ---: | ---: | --- |
| AI article (medium, Quick Draft) | OpenAI | tokens x calls | USD 0.00882 | USD 0.01147 | medium |
| AI article (medium, Deep Write) | OpenAI | tokens x calls | USD 0.02301 | USD 0.02991 | medium |
| AI image (average scenario) | image provider | image | USD 0.05 | USD 0.065 | low |
| AI image (HQ scenario) | image provider | image | USD 0.10 | USD 0.13 | low |
| Keyword research (base, 10 Labs calls) | DataForSEO | provider calls | USD 0.12 | USD 0.156 | low |
| Keyword research (low, 1 call) | DataForSEO | provider calls | USD 0.012 | USD 0.0156 | low |
| Keyword research (high, 20 calls) | DataForSEO | provider calls | USD 0.24 | USD 0.312 | low |
| Competitor research | DataForSEO | provider calls | same call-cost model as keyword research | | low |
| SERP rank (per keyword, standard) | DataForSEO | SERP call | USD 0.0006 | USD 0.00078 | low |
| SERP rank (per keyword, live) | DataForSEO | SERP call | USD 0.0020 | USD 0.0026 | low |
| X post (no link) | X | post | EUR 0.01 | EUR 0.013 | low |
| X link post | X | link post | EUR 0.20 | EUR 0.26 | low |
| Media asset (stored 1 month) | Supabase | GB-month | see table below | | high |
| Media asset (served) | Supabase | GB egress | see table below | | high |
| Embedding (1M tokens) | OpenAI | tokens | USD 0.02 | USD 0.026 | high |

AI image cost remains `UNKNOWN`: the repository default `dall-e-3` is absent
from the current OpenAI list and current models are token-priced
(`gpt-image-1.5` is 8.00 in / 32.00 out per 1M), so per-image cost depends on an
unresolved model choice and output-token count. The 0.05 / 0.10 figures are
planning assumptions only. A token-priced HQ image can plausibly exceed 0.10,
so the scenario likely **understates** the high end.

DataForSEO scenario (assumed Labs 0.012 per call, UNVERIFIED) and SERP scenario
(assumed standard 0.0006 / live 0.0020 per call, UNVERIFIED):

| Provider calls | Labs raw | Labs safe @1.30 | SERP std raw | SERP std safe | SERP live raw | SERP live safe |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.0120 | 0.0156 | 0.0006 | 0.00078 | 0.0020 | 0.0026 |
| 10 | 0.1200 | 0.1560 | 0.0060 | 0.00780 | 0.0200 | 0.0260 |
| 20 | 0.2400 | 0.3120 | 0.0120 | 0.01560 | 0.0400 | 0.0520 |

X, per post (native EUR):

| Posts | Normal raw | @1.15 | @1.30 | @1.50 | Link raw | @1.15 | @1.30 | @1.50 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.01 | 0.0115 | 0.013 | 0.015 | 0.20 | 0.23 | 0.26 | 0.30 |
| 25 | 0.25 | 0.2875 | 0.325 | 0.375 | 5.00 | 5.75 | 6.50 | 7.50 |
| 100 | 1.00 | 1.15 | 1.30 | 1.50 | 20.00 | 23.00 | 26.00 | 30.00 |

The 20x gap between link and non-link posts means they must never be averaged
without an explicit weight.

Media (native USD). Storage is per GB-month; egress is per full serve. No
`/render/image` call exists repository-wide (`getPublicUrl` only), so image
transforms cost nothing (`VERIFIED_REPOSITORY`).

| Asset | GB | Storage / month | Egress cached | Egress uncached |
| ---: | ---: | ---: | ---: | ---: |
| 1 MB | 0.001 | 0.0000213 | 0.00003 | 0.00009 |
| 10 MB | 0.01 | 0.000213 | 0.0003 | 0.0009 |
| 50 MB | 0.05 | 0.001065 | 0.0015 | 0.0045 |
| 100 MB | 0.1 | 0.002130 | 0.0030 | 0.0090 |

Media is sub-cent at any realistic volume; it is not a cost driver. Whether
public-object traffic bills as cached or uncached egress remains `UNKNOWN`
(36.5.1); the cached column is the optimistic bound.

AI image scenarios (planning only):

| Images | Raw @0.05 | Safe @1.30 | Raw @0.10 HQ | Safe @1.30 HQ |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.05 | 0.065 | 0.10 | 0.13 |
| 10 | 0.50 | 0.65 | 1.00 | 1.30 |
| 25 | 1.25 | 1.625 | 2.50 | 3.25 |
| 50 | 2.50 | 3.25 | 5.00 | 6.50 |
| 100 | 5.00 | 6.50 | 10.00 | 13.00 |

#### 36.6.3 Allowance scenarios

Fictional allowances below are **calculation examples only** (not a
recommendation). Unit costs are safe @1.30; `worst` = 100 percent utilization,
`base` = 40 percent, `stress` = 80 percent (36.5 worksheet parameters).
Magnitudes in native currency (AI/DataForSEO USD, X EUR).

AI article (medium Quick Draft, safe USD 0.01147):

| Allowance | worst | base (40%) | stress (80%) |
| ---: | ---: | ---: | ---: |
| 10 | 0.1147 | 0.0459 | 0.0918 |
| 50 | 0.5735 | 0.2294 | 0.4588 |
| 200 | 2.2940 | 0.9176 | 1.8352 |

Keyword research (base 10 Labs calls, safe USD 0.156):

| Allowance | worst | base (40%) | stress (80%) |
| ---: | ---: | ---: | ---: |
| 10 | 1.560 | 0.624 | 1.248 |
| 50 | 7.800 | 3.120 | 6.240 |
| 200 | 31.200 | 12.480 | 24.960 |

AI image (average 0.05, safe USD 0.065):

| Allowance | worst | base (40%) | stress (80%) |
| ---: | ---: | ---: | ---: |
| 10 | 0.650 | 0.260 | 0.520 |
| 50 | 3.250 | 1.300 | 2.600 |
| 200 | 13.000 | 5.200 | 10.400 |

X link post (safe EUR 0.26):

| Allowance | worst | base (40%) | stress (80%) |
| ---: | ---: | ---: | ---: |
| 5 | 1.300 | 0.520 | 1.040 |
| 25 | 6.500 | 2.600 | 5.200 |
| 100 | 26.000 | 10.400 | 20.800 |

Curve shape: AI articles and media are flat enough to allocate freely;
DataForSEO research and X link posts scale into real money; AI images sit in
between and are additionally encumbered by an unresolved provider rate.

#### 36.6.4 Plan economics

Illustrative plan prices and allowances below are **ECONOMIC MODEL INPUT ONLY**
and are not a pricing or allowance decision. Prices in EUR; costs converted at
`FX_USD_EUR = 0.92` (planning).

| Tier | Price | AI articles | Keyword research | AI images | X link posts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starter | EUR 29 | 10 | 10 | 10 | 5 |
| Pro | EUR 79 | 50 | 50 | 50 | 25 |
| Agency | EUR 199 | 200 | 200 | 200 | 100 |

Per tier (safe @1.30; base 40 percent, stress 80 percent; costs in EUR):

| Tier | Price | base cost | base margin | stress cost | stress margin | worst cost | worst margin |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Starter | 29 | 1.38 | 95.3% | 2.75 | 90.5% | 3.44 | 88.1% |
| Pro | 79 | 6.88 | 91.3% | 13.75 | 82.6% | 17.19 | 78.2% |
| Agency | 199 | 27.51 | 86.2% | 55.02 | 72.4% | 68.77 | 65.4% |

At these examples every tier clears the 70 percent working margin floor at
base and at 80 percent utilization; only Agency at full utilization (100
percent) drops below it (65.4 percent). The result is sensitive to the example
allowances, so P16.4 must confirm the allowance matrix before quoting margin.

Price-point view (base 40 percent cost, using the same example allowances) to
show where economics become comfortable. Cost is nearly price-independent at
these example allowances, so margin rises with price; the interesting zone is
where a *realistic* allowance still clears the margin floor once provider rates
are contract-verified.

| Price EUR | base cost (Agency example) | base margin |
| ---: | ---: | ---: |
| 19 | 27.51 | -44.8% |
| 29 | 27.51 | 5.1% |
| 49 | 27.51 | 43.9% |
| 79 | 27.51 | 65.2% |
| 99 | 27.51 | 72.2% |
| 149 | 27.51 | 81.5% |
| 199 | 27.51 | 86.2% |
| 299 | 27.51 | 90.8% |

Read together with the per-tier table: the same allowance set is ruinous at
EUR 19-29 and comfortable from roughly EUR 79 up. That is exactly the kind of
decision P16.4 must make explicitly.

#### 36.6.5 Sensitivity analysis

Four axes, evaluated on the Agency example (base cost EUR 27.51 at 40 percent
utilization, safety 1.30, 10 DataForSEO calls, 40 X link posts consumed = 40
percent of the 100 allowance).

A. Utilization (20 / 40 / 60 / 80 percent):

| 20% | 40% | 60% | 80% |
| ---: | ---: | ---: | ---: |
| 13.75 | 27.51 | 41.26 | 55.02 |

B. Safety factor (1.15 / 1.30 / 1.50):

| 1.15 | 1.30 | 1.50 |
| ---: | ---: | ---: |
| 24.34 | 27.51 | 31.74 |

C. DataForSEO provider calls per research action (1 / 10 / 20):

| 1 call | 10 calls | 20 calls |
| ---: | ---: | ---: |
| 17.18 | 27.51 | 38.99 |

D. X link-post consumption (5 / 25 / 50 / 100 actual posts; the base has 40
consumed at 40 percent of the 100 allowance):

| 5 posts | 25 posts | 50 posts | 100 posts |
| ---: | ---: | ---: | ---: |
| 18.41 | 23.61 | 30.11 | 43.11 |

Ranking by swing on the Agency example: utilization (13.75 -> 55.02,
EUR 41.27) is the largest single lever because it multiplies everything, then
X link-post consumption (18.41 -> 43.11, EUR 24.70), then DataForSEO call
cardinality (17.18 -> 38.99, EUR 21.81), then safety factor (24.34 -> 31.74,
EUR 7.40). Two consequences:

- Safety factor is a second-order knob at these volumes; it cannot rescue a
  badly sized X or DataForSEO allowance.
- The two axes that matter most (X link posts, DataForSEO call count) are also
  the two with the least verified cost basis. That uncertainty is the core
  risk to the plan margins.

#### 36.6.6 Break-even analysis

Maximum operator-funded expected cost per month at a target gross margin:
`maximum_cost = price x (1 - target_margin)`.

| Price EUR | 50% margin | 60% margin | 70% margin | 80% margin |
| ---: | ---: | ---: | ---: | ---: |
| 19 | 9.50 | 7.60 | 5.70 | 3.80 |
| 29 | 14.50 | 11.60 | 8.70 | 5.80 |
| 49 | 24.50 | 19.60 | 14.70 | 9.80 |
| 79 | 39.50 | 31.60 | 23.70 | 15.80 |
| 99 | 49.50 | 39.60 | 29.70 | 19.80 |
| 149 | 74.50 | 59.60 | 44.70 | 29.80 |
| 199 | 99.50 | 79.60 | 59.70 | 39.80 |
| 299 | 149.50 | 119.60 | 89.70 | 59.80 |

Example check: EUR 79 at 70 percent margin allows at most EUR 23.70 expected
operator cost per month.

Cross-checking the Agency example: at EUR 199 / 70 percent the ceiling is
EUR 59.70, and the Agency *worst-case* example cost is EUR 68.77 - it breaks
the floor; the base (EUR 27.51) and stress (EUR 55.02) cases do not. This is
the single most useful output for P16.4: it converts a price into the cost
budget each allowance set must fit inside, and shows the Agency example is
only safe if full-utilization behavior is bounded (or allowances are lowered).

#### 36.6.7 Commercial findings

1. Cheap enough to allocate generously: AI text (articles), media
   storage/egress, embeddings. Even 200 medium quick-draft articles are under
   USD 2.30 worst-case, and media is sub-cent. These should be positioned as
   broad capabilities, not scarce credits.
2. Keep scarce: DataForSEO research, X link posts, and (pending a rate) AI
   images. These are the only units that move the plan margin.
3. Too uncertain to quote definitively: DataForSEO (no contract rate), AI
   images (model and per-image cost unresolved), X (no public rate). They may
   appear as scenarios, not as verified allowances.
4. X link posting deserves its own allowance. At EUR 0.20 vs EUR 0.01 it is 20x
   a normal post; merging them into "X posts" would silently blend a cheap and
   an expensive action. The `x_link_post` resource already isolates the link
   case in admission and metering.
5. DataForSEO: keep one product allowance for v1
   (`dataforseo_research` already exists), but model call cardinality
   explicitly and consider separating the SERP (`serp_request`) path later if
   usage shows it dominates. One allowance today, two possible later.
6. AI text is cheap enough to be a broad, capability-level feature on every
   paid tier; it should not be the thing that distinguishes tiers.
7. AI image economics are **not** sufficient for a concrete allowance until the
   operator model is chosen; the high end is plausibly above the 0.10 scenario.
8. The resource that most likely determines plan economics is DataForSEO
   research, with X link posts the largest single swing factor. AI text and
   media will not decide any plan.

#### 36.6.8 P16.4 inputs

Concrete decisions P16.4 must take before allowances are fixed:

**Safe to price now** (cost basis reliable):

- AI text (`ai_generation`): `gpt-4o-mini` at verified official rates; price
  from token scenarios, allocate generously.
- Media (`media`): Supabase storage/egress at verified official rates; no
  image transforms; allocate generously.
- Embeddings (uncapped, not an entitlement resource): verified 0.02 / 1M; keep
  as a monitored cost, not an allowance.

**Price with scenario** (usable planning rate, no verified provider rate):

- DataForSEO research (`dataforseo_research`): price with the 1/10/20-call
  model and an explicit contract-rate placeholder; do not hard-code a rate.
- X link posts (`x_link_post`) and normal X posts: price from the 0.01 / 0.20
  EUR planning assumptions, kept separate.
- AI images (`ai_image`): scenario only.

**Do not hard-code yet** (economics insufficient or UNKNOWN):

- AI image per-image cost (model choice unresolved; `dall-e-3` unlisted).
- Any DataForSEO per-call rate and the `serp_request` live/standard blend.
- Supabase public-object traffic as cached vs uncached egress.
- X per-post contract rate for link and non-link.

**P16.4 decisions required:**

1. Choose the operator image model and derive a real per-image cost.
2. Obtain the DataForSEO contract rate card; decide the `serp_request`
   live/standard blend.
3. Obtain the current X API plan economics for link vs non-link.
4. Decide whether Supabase public-object traffic bills as cached egress.
5. Fix the allowance matrix per tier, using the break-even ceilings in 36.6.6
   as the budget, and confirm each tier clears the chosen margin floor at
   expected and stress utilization.
6. Decide whether X link posting is a separate allowance (36.6.7 finding 4).
7. Decide whether DataForSEO stays one allowance or splits into research vs
   SERP (36.6.7 finding 5).
8. Revisit `safety_factor` (1.30), `expected_utilization` (0.40) and the
   margin floor (70 percent) with real evidence; none is settled.

## 37. P17 Proposal

If P16 finds no architectural blockers (it does not):

> **P17 - Billing Foundation & Stripe Integration**

P17 may build only what P16 established:

```text
Stripe customer
       ↓
checkout
       ↓
subscription
       ↓
verified webhook
       ↓
billing state
       ↓
P15 plan assignment (append-only seo_account_entitlements)
       ↓
P13 entitlement
       ↓
P14 resource enforcement
```

Suggested P17 scope:

1. Migration: `seo_billing_customers`, `seo_billing_subscriptions`,
   `seo_billing_events`, `seo_plan_prices` (RLS + smoke checks).
2. Shared append-only plan-switch function reused by admin + billing.
3. Stripe client (server-only), Checkout session creation, Customer Portal
   session creation, `GET /api/billing`.
4. Webhook route (raw body, signature verification, idempotent persistence,
   durable-worker processing, subscription re-fetch).
5. Billing-state -> plan-assignment mapping with graceful degradation.
6. Tests per section 33; docs update.

P17 must not build anything P16 did not recommend.

## 38. Explicitly Out of Scope

P16 did not: install Stripe; add Stripe keys; add the Stripe SDK; implement
webhooks; implement checkout; implement subscriptions/customers/invoices/payment
collection; invent prices or allowances (the 36.6 figures are labelled ECONOMIC
MODEL INPUT ONLY and are not plan decisions); rewrite P13/P14 entitlement logic;
redesign the P15 catalog; replace the usage ledger; introduce credits; or build
provider-cost accounting.

## 39. Verification

P16 is a **documentation-only** phase. No product code, schema or test changed.

- `pnpm lint` - unchanged (pre-existing warnings only).
- `pnpm typecheck` - unchanged.
- `pnpm test` - unchanged and green.
- `pnpm build` - unchanged and green.
- `git diff --check` - clean.

No migration was added; no P15/P16 bug was found that requires a correction.
