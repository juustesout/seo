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
  capacity, API/MCP, larger allowances.

The tiers describe capability. Concrete numeric allowances and prices are
attached afterwards (36.2 and 36.4); a tier is not a fixed credit count.

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
| Shared/business accounts (account members) | **UNKNOWN** (no `seo_account_members` yet) |
| Price display source (P15 metadata vs mapping) | **RECOMMENDED** (P15 for display; mapping for charge) |
| API/MCP as a paid capability (which tier) | **UNKNOWN** |
| Project-count limits per tier | **UNKNOWN** |

### 36.3 Decision Notes

- A/B/C are foundational: they fix billing scope, the free boundary and tier
  meaning. The first three rows of 36.2 (prices, billing interval, allowances)
  depend on them and must be derived from unit economics, not guessed.
- None of A/B/C needs a schema change; all are consistent with P13/P14/P15 as
  built.
- BYOK stays outside hosted allowances (section 22), so paid tiers meter only
  operator-funded capacity.

### 36.4 Pricing and Allowance Matrix (to be filled once unit costs are known)

| | Free | Starter | Pro | Agency |
| --- | --- | --- | --- | --- |
| Price / month | EUR 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| AI text | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| AI images | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| DataForSEO | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| X link posts | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| API | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| MCP | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| Projects | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

Do not silently decide commercially meaningful choices.

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
collection; invent prices or allowances; rewrite P13/P14 entitlement logic;
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
