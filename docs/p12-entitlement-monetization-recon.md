# P12 - Entitlement & Monetization Recon

> **RECON ONLY.**
>
> P12 performs no implementation. It adds no migrations, no tables, no API
> routes, no UI, no plans, no subscriptions, no Stripe, no pricing, no credits,
> no entitlement enforcement and no feature tiers. It reads the codebase and
> the P9/P10/P11 deliverables and writes down what an entitlement layer would
> have to decide, where it would sit, and which resources can carry a product
> entitlement at all.
>
> Every monetary amount is **External pricing/configuration required**. Items
> the codebase cannot answer are marked **UNKNOWN - requires product decision**.

Baseline documents:

- `docs/p9-resource-protection.md` - technical admission foundation (async jobs).
- `docs/p10-resource-economics-monetization-recon.md` - resource economics recon.
- `docs/p11-resource-protection.md` - protection completion (sync work, funding).
- `docs/r5.10.1-usage-vocabulary.md` and `docs/r5.10.2-usage-ledger.md` -
  the usage fact vocabulary and ledger.
- `docs/r5.10.8-usage-read-reporting.md` - the usage read surface.

Source of truth is the codebase where docs and code disagree; that is noted
inline.

---

## 1. Executive Summary

P9, P10 and P11 leave the product in a deliberate state:

- **Technical protection is complete.** Every expensive server-funded operation
  is bounded and attributable, async (P9 `seo_admit_job`) and sync (P11
  `seo_admit_resource`), at project and account scope. There are no plans in
  that layer and there must never be.
- **Usage is measured, not priced.** `seo_usage_events` records immutable facts
  (`category`, `provider`, `operation`, `quantity`, `unit`, `success`, scope,
  and now `funding_source`). No cost is stored.
- **No commercial layer exists.** No plan, subscription, entitlement, credit,
  quota, price, invoice or billing surface exists in code or schema.

P12's findings:

1. **A clean, small commercial surface already exists.** The only resources the
   operator actually pays for are AI text, AI image, embeddings, DataForSEO and
   the always-server-funded knowledge infrastructure (Jina/Cohere/Qdrant).
   These are the only credible first monetization candidates.
2. **Several expensive resources must never be monetized** because the user
   already funds them: Google GSC/GA4/Ads and WordPress/X publishing. They stay
   technically protected and metered, never commercially gated.
3. **`funding_source` changes the product, not just the ledger.** A BYOK call
   costs the operator nothing; an operator-funded call does. A future
   entitlement layer must treat these differently for the same resource.
4. **The metering is good enough for allowances but not yet for customer-facing
   units.** Technical granularity is high (`serp_request`, `keyword`,
   `input_token`, ...); no customer concept aggregates it yet. That aggregation
   is a deliberate product decision, not a missing measurement.
5. **Enforcement belongs above P9/P11, at the admission seam or as a lowered
   effective ceiling.** P9/P11 stay plan-unaware. The entitlement layer
   computes an effective ceiling and feeds the existing admission primitive.
6. **Scope is mostly already decided by the architecture**: account for shared
   money-based allowances, project for stateful resources (tracked keywords,
   schedules, integrations), user only for things that are truly personal
   (API/MCP credentials).
7. **Raw usage beats credits for a first version.** The ledger is truthful and
   provider-cost-variable; introducing credits adds a conversion layer whose
   rate would have to change every time a provider changes, with no benefit the
   ledger does not already provide. Credits remain an option, not a starting
   point.
8. **P13 is blocked on product decisions, not on code.** The technical
   prerequisites are already in place (funding attribution, scope, admission).
   The remaining P0 item is a product decision: which resources are sold, on
   which plan, and whether BYOK is exempt.

**Recommended first commercial architecture:** a **base plan with feature
entitlements plus operator-funded resource allowances, enforced as a lowered
effective ceiling above the P9/P11 floor**, with BYOK consumption exempt from
operator-funded allowances. No credits in version 1. Details in section 23.

---

## 2. Canonical Resource -> Entitlement Matrix

This is the single canonical matrix. It combines the P10 taxonomy, the
`RESOURCE_KINDS` vocabulary (`packages/contracts/src/resourceProtection.ts:34`)
and the final `seo_usage_events` reality.

| Resource | Economic cost | Funding | Scope | Monetizable? | Entitlement model | Enforcement |
| --- | --- | --- | --- | --- | --- | --- |
| AI text generation (`ai_generation`) | High, variable (tokens) | BYOK or operator | Account (shared) | **YES** | allowance (tokens or runs) + feature flag for premium flows | sync admission (`seo_admit_resource`) / effective ceiling |
| AI image (`ai_image`) | Medium, per generation | BYOK or operator | Account (shared) | **YES** | credit-per-generation or allowance | sync admission |
| AI embeddings (`ai_embedding`) | Low per call, high in bulk | Operator only | Account (or project) | **YES** (bundled) | bundled into knowledge/AI allowance | sync admission |
| DataForSEO research (`dataforseo_research`) | High, per task | BYOK or operator | Account + project | **YES** | research allowance | P9 trigger (async) |
| DataForSEO SERP (`dataforseo_serp`) | High, per request | BYOK or operator | Account + project | **YES** | research allowance | P9 trigger |
| DataForSEO keywords (`dataforseo_keywords`) | High, per keyword/task | BYOK or operator | Account + project | **YES** | research allowance | P9 trigger |
| Google Search Console (`google_search_console`) | Operator ~0 (user quota) | BYOK (user OAuth) | Project | **NO** | none (monitor only) | P9 trigger |
| Google Analytics (`google_analytics`) | Operator ~0 (user quota) | BYOK (user OAuth) | Project | **NO** | none (monitor only) | P9 trigger |
| Google Ads (`google_ads`) | Operator ~0 (user quota) | BYOK (user OAuth) | Project | **NO** | none (monitor only) | P9 trigger |
| Publishing (`publishing`) | Operator ~0 (user creds) | BYOK | Project | **NO** | none; destination count may become a feature limit | P9 trigger |
| Media/stock (`media`, Unsplash) | Low, server key | Operator | Project | **MAYBE** | bundled with AI/media | P9 trigger + sync admission |
| Knowledge infra (Jina/Cohere/Qdrant) | Server-funded, unmetered per op | Operator | Project | **NO** | internal, bundled | not individually metered |
| Background jobs (`background_job`) | Worker compute | Mixed / null | Account + project | **NO** | technical only | P9 trigger |
| Projects | Low infra cost | n/a | Account | **PRODUCT DECISION** | count as feature limit | none today |
| Tracked keywords | Storage + refresh cost | Operator | Project | **MAYBE** | state allowance (count) | none today (state) |
| Scheduled jobs | Drives other resource cost | Mixed | Project | **MAYBE** | bounded by the resource it consumes | P9 trigger (its work) |
| API access (`/api/v1`) | Low direct, abuse surface | n/a | Project / account | **MAYBE** | feature flag + rate limit | rate limiter |
| MCP access (`/api/mcp`) | Low direct, abuse surface | n/a | Project / account | **MAYBE** | feature flag | rate limiter |
| Storage / uploads | UNKNOWN | Operator | Account/project | **PRODUCT DECISION** | quota + overage (if any) | none today |

Rationale for every `YES`/`MAYBE` follows in sections 4 and 5.

---

## 3. Technical vs Usage vs Entitlement

Three concepts that must stay separate:

```text
Technical protection  -> "can the system safely perform this?"
Usage metering        -> "how much resource was actually consumed?"
Product entitlement   -> "is this account allowed to consume it by policy?"
```

The future pipeline is:

```text
Resource request
      |
      v
Technical protection   (P9/P11 - always applies, plan-unaware)
      |
      v
Entitlement policy     (future - may only LOWER the effective ceiling)
      |
      v
Usage                  (ledger - post-hoc fact, unchanged)
```

Findings about ordering:

- **Technical protection must run first and unconditionally for every
  resource.** It is the floor; a plan can never raise it
  (`docs/p11-resource-protection.md` section 19).
- **Entitlement is a pre-admission decision, not a second admission system.**
  The clean shape is: entitlement resolves an *effective ceiling* (the minimum
  of the technical ceiling and the plan allowance) and the existing admission
  primitive enforces it atomically. This avoids a parallel enforcement path that
  could drift from P9/P11.
- **Usage is never the enforcement input at request time.** The ledger is
  append-only and eventually consistent with in-flight work; using it as a live
  counter would race. It is the correct input for *period aggregation* and for
  showing the user what they consumed, and it can feed the effective ceiling by
  producing a period-to-date total, but the atomic decision still lives in the
  database.
- **The order holds for all resource types**, because every protected resource
  is already admitted through exactly one of the two P9/P11 primitives. There is
  no resource that bypasses both.
- One subtlety: **feature entitlements (on/off) are a different axis** from
  resource allowances (how much). A feature flag can deny before technical
  protection (e.g. "API access not in plan"), but that is still an
  entitlement-policy decision, not a technical one. The two must report
  different UI states (section 18).

---

## 4. Monetization Candidates

Assessed against nine dimensions: direct marginal cost, user value,
understandability, abuse risk, allowance fit, feature-entitlement fit,
concurrency fit, credits fit, overage fit, BYOK-exemption fit.

### 4.1 DataForSEO (research / SERP / keywords)

- **Why monetizable:** the operator pays DataForSEO per task/request/keyword
  unless the user supplies a DataForSEO key; usage events already emit
  `serp_request`, `keyword`, `request`/`task` (`docs/r5.10.1-usage-vocabulary.md`
  section 7).
- **Direct marginal cost:** high and per-unit.
- **User value:** high - keyword/competitor research is a core job-to-be-done.
- **Understandability:** good as "keyword research" but poor if exposed as
  vendor tasks; needs a product unit (section 8).
- **Abuse risk:** high; large seed lists are a known bypass, already clamped at
  the executor (P11 section 10).
- **Allowance:** yes. **Feature entitlement:** no (it is core). **Concurrency:**
  yes (already partly via P9). **Credits:** possible but unnecessary.
  **Overage:** natural. **BYOK exemption:** yes - a user key should not consume
  the operator allowance.

### 4.2 AI text generation (`ai_generation`)

- **Why monetizable:** OpenAI tokens are a real operator cost when no BYOK key
  is present; the ledger emits `input_token`/`output_token`.
- **Direct marginal cost:** high, variable by model.
- **User value:** very high.
- **Understandability:** "AI generations" is intuitive; tokens are not.
- **Abuse risk:** high (loops, in-editor calls); bounded by `ai_generation`
  in-flight ceilings today.
- **Allowance:** yes. **Feature entitlement:** yes for premium flows.
  **Concurrency:** yes. **Credits:** possible. **Overage:** yes.
  **BYOK exemption:** yes.

### 4.3 AI image (`ai_image`)

- **Why monetizable:** per-generation cost with a clean countable unit
  (`image_generation`).
- **Direct marginal cost:** medium, per image.
- **User value:** high; highly visible.
- **Understandability:** excellent (one image = one unit).
- **Abuse risk:** medium.
- **Allowance:** yes. **Feature entitlement:** no. **Concurrency:** yes.
  **Credits:** strong fit. **Overage:** yes. **BYOK exemption:** yes where the
  user can supply an image key.

### 4.4 Embeddings (`ai_embedding`)

- **Why monetizable:** operator-funded in bulk; embeddings are always
  server-funded (env-only), and account attribution is back-filled
  (`docs/p10-...` section 6.2).
- **Direct marginal cost:** low per call, grows with corpus size.
- **User value:** indirect (powers knowledge/search).
- **Understandability:** poor standalone; should be bundled.
- **Abuse risk:** medium (large ingestion).
- **Allowance:** as part of a knowledge/AI allowance. **Feature entitlement:**
  no. **Concurrency:** yes (already protected). **Credits:** no (too internal).
  **Overage:** bundled. **BYOK exemption:** not applicable today (no BYOK path).

### 4.5 Content generation / editing

- **Why monetizable:** these are *product surfaces* over `ai_generation`, not
  separate resources. They should be feature flags ("AI editing enabled") rather
  than separate meters, to avoid double-counting the same tokens.

### 4.6 Scheduled jobs

- Not directly monetizable. Their cost is the cost of the resource they consume
  (AI/DataForSEO) and is already metered when it runs. Treat as a feature/limit
  on count, not a separate meter.

### 4.7 Projects / tracked keywords

- **Projects:** operator infra cost is low; a project count is a classic feature
  limit, but it is a **PRODUCT DECISION** whether to gate it at all. The
  architecture currently has no cap (`seo_projects` insert only requires
  `created_by = auth.uid()`).
- **Tracked keywords:** a *state* (how many are watched) not a consumption;
  refresh work is the real cost and is metered when jobs run. A count cap is
  plausible but is a state allowance, not a usage allowance (section 15).

### 4.8 Publishing destinations / Google integrations / WordPress-X

- **Not monetizable:** user credentials fund them. Destination count could be a
  feature limit (seats/sites), but the API cost is the user's.

### 4.9 API / MCP access

- Low direct cost; primary concern is abuse. Best modeled as a **feature
  entitlement** (on/off) plus technical rate limits, not a usage meter.

### 4.10 Storage / media

- Surfaces exist but no byte-level metering exists. Whether storage is sold is a
  **PRODUCT DECISION**; if sold it needs new metering that does not exist today.

---

## 5. Never-Monetize Candidates

Resources that stay technically protected and are metered for visibility but
should not carry a commercial quota.

| Resource | Why not monetized | "Free because cheap" or "wrong to monetize"? |
| --- | --- | --- |
| Google GSC / GA4 / Ads reads | User's own Google quota and OAuth fund them | **Wrong to monetize** - the user already pays Google |
| WordPress / X publishing | User's own credentials and site | **Wrong to monetize** - the user owns the destination |
| Authentication / account creation | Platform obligation | Wrong to monetize |
| Internal DB operations | No external cost | Free because cheap |
| Technical rate limits (`jobs_create_rate`, `sync_create_rate`, `*_inflight`) | Abuse/safety, not value | Wrong to monetize - charging for safety bounds is hostile |
| Queue depth / concurrency (`jobs_queued`, `jobs_running`) | Operational safety | Wrong to monetize except as an optional future "priority" |
| Jina / Cohere / Qdrant internals | Bundled infrastructure | Free because internal |
| Google OAuth token exchange | Unmetered infrastructure | Free because cheap |

Explicit distinction: the middle column matters. Charging a user for their own
Google quota or their own WordPress site is not merely unnecessary, it is a
model that would be perceived as double-charging. Charging for queue slots would
turn a safety mechanism into a toll. These are **product-policy prohibitions**,
not cost judgments.

---

## 6. Funding Model

P11 introduced `funding_source` (`byok` / `operator_funded` / null) on
`seo_usage_events`. It is a *technical attribution* dimension, not billing
(`packages/contracts/src/usageEvent.ts:54-69`). For entitlements it is decisive.

### A. Must BYOK usage be unlimited?

**Recommended: unlimited for the monetized resource, but not for the product.**
BYOK means the operator pays nothing for the external call, so a monetary
allowance would be charging for cost that was never incurred. But BYOK does not
remove:
- technical protection (queues, concurrency, rate limits) - these are safety;
- feature entitlements (API/MCP/editing availability) - these are product;
- state limits (project count, tracked keywords) - these are platform cost.

So: BYOK exempts the *allowance* dimension, never the protection or feature
dimensions.

### B. Must BYOK respect only technical protection?

**Effectively yes for the resource cost**, with the caveat in A: BYOK still
respects feature and state entitlements. BYOK is the strongest reason to keep
the monetary allowance separate from the technical floor.

### C. Should operator-funded usage fall under subscription allowances?

**Yes.** Operator-funded consumption is the operator's cost and is exactly what
an allowance exists to bound and sell. This is the primary meter.

### D. Resources where BYOK and operator-funded need the same entitlement?

**Yes, for feature/state entitlements.** Example: whether the *edit* feature or
*API* access exists is a product decision independent of who pays the provider.
The `edit` feature is on or off regardless of BYOK. Likewise project/tracked-
keyword counts are platform state, not provider cost, so funding does not
change them.

### E. Resources where BYOK needs a feature entitlement despite user paying?

**Yes.** API/MCP access, premium editing flows, seat/site counts and any
"advanced" feature remain product decisions even when the user brings their own
provider key. The user paying OpenAI does not entitle them to every product
surface.

### Funding matrix

| Resource | BYOK possible | Operator-funded possible | Recommended policy |
| --- | --- | --- | --- |
| `ai_generation` | Yes (account/project OpenAI key) | Yes (env key) | BYOK exempt from allowance; feature + technical still apply |
| `ai_image` | Yes | Yes | BYOK exempt from allowance |
| `ai_embedding` | No (env-only today) | Yes | Operator allowance only |
| `dataforseo_research/serp/keywords` | Yes (DataForSEO key) | Yes (env fallback) | BYOK exempt from allowance |
| `google_search_console/analytics/ads` | Always BYOK (user OAuth) | No | Never monetized; monitor only |
| `publishing` | Always BYOK (user creds) | No | Never monetized; destinations may be a feature limit |
| `media` (Unsplash) | No (env) | Yes | Bundled allowance |
| `media` (OpenAI image) | Yes | Yes | BYOK exempt from allowance |
| `background_job` | n/a | n/a | Technical only; never monetized |
| Knowledge infra (Jina/Cohere/Qdrant) | No | Yes | Internal; bundled |

No enforcement is implemented here. This matrix is policy guidance only.

---

## 7. Product Models

Candidate models, assessed structurally (no prices).

| Model | Fits | Does not fit | Notes |
| --- | --- | --- | --- |
| **Feature entitlement** (on/off) | API, MCP, AI editing, publishing destinations | Usage-bound resources | Clean, low complexity; independent of funding |
| **Allowance** (included amount/period) | AI text, AI image, DataForSEO, embeddings, media | State resources (tracked keywords are state) | Primary model for operator-funded cost |
| **Credit model** (abstract unit) | AI image (one image), possibly AI generation | Provider-variable token cost | Adds a conversion rate that must track provider changes (section 16) |
| **Concurrency** | AI generation, DataForSEO, embeddings | Most other resources | Already partly expressed as P11 `*_inflight`; a plan can lower it |
| **Project limits** | Projects, seats/destinations | Provider cost | Product decision; not a resource meter |
| **Usage + overage** | AI text, DataForSEO | Embeddings, infra | Natural extension of an allowance once cost derivation exists |

Assessment:

- **Feature entitlements** are the cheapest to add and the most understandable
  ("API access is not in your plan").
- **Allowances** are the correct model for operator-funded, variable-cost
  resources, because the ledger already counts them and the user can understand
  a monthly amount.
- **Concurrency** should be expressed by *lowering the P11 effective ceiling*,
  not by a separate mechanism. P11 already has `*_inflight`; a plan only changes
  the number.
- **Project limits** are orthogonal and optional.
- **Overage** requires cost derivation, which does not exist (section 22 P2).

**Recommended combination for v1:** feature entitlements + operator-funded
allowances + plan-lowered concurrency. No credits, no overage initially.

---

## 8. Resource Units

What is "one unit" for each monetizable resource, and is the existing metering a
reliable unit?

| Resource | Natural user unit | Ledger unit(s) today | Reliable? | Customer-facing suitability |
| --- | --- | --- | --- | --- |
| DataForSEO research | 1 research request | `request`, `task`, `keyword`, `serp_request` | Yes | Too technical -> aggregate into "research credits" |
| AI text | 1 generation (or token) | `input_token`, `output_token` | Yes | Tokens too technical -> "generations" or a bundled allowance |
| AI image | 1 image | `image_generation` | Yes | Excellent as-is |
| Embeddings | 1 embedding batch / doc | `input_token` | Yes | Too technical -> bundle under knowledge |
| Media stock | 1 asset | `asset` | Yes | Good |
| Publishing | 1 attempt | `publish_attempt` | Yes | Never monetized |

Findings:

- **Existing usage events already have reliable, unambiguous units** - the
  `quantity + unit` rule is enforced by contract and DB CHECK
  (`docs/r5.10.1-usage-vocabulary.md` section 4).
- **The gap is not measurement but aggregation.** No customer-facing unit
  aggregates DataForSEO's four units or AI's two token units. That aggregation
  is a product decision: it fixes what the customer thinks they are buying.
- **Do not expose raw provider units.** `input_token`/`serp_request` belong
  internally (section 8 goal: "technical granularity internally, simple product
  language externally").
- **One caution:** AI tokens vary by model and prompt size, so a "generation"
  unit has variable operator cost. Either accept the variance (simple) or price
  on tokens (accurate but opaque). This is the key unit decision (section 16).

---

## 9. Usage Accounting Suitability

Assessment of `seo_usage_events` as the input to entitlement enforcement and
reporting. Final column list is in migration `20260101000031_usage_events.sql`
plus `funding_source` from `20260101000040_sync_resource_protection.sql`.

| Dimension | Finding | Rating |
| --- | --- | --- |
| Reliable counting | Append-only, idempotent via `source_id` partial unique indexes; `append` treats 23505 as duplicate | **READY** |
| Event granularity | Precise (unit-level); may be too fine for customer-facing display but correct for aggregation | **READY** (internal) |
| Funding known | `funding_source` present; derived at credential resolution | **READY** |
| Account known | Present; back-filled from project on insert | **READY** |
| Project known | Present where applicable | **READY** |
| Retries double-count | Retries that re-call the provider carry a new `source_id` and correctly become new facts; a job retry that does not re-call emits nothing new | **READY** |
| Failed requests | `success=false` facts are recorded and must be excluded (or separately metered) for allowance purposes | **MINOR GAP** - the read surface groups by unit but the allowance must decide failure policy |
| Determinism | Facts are deterministic given an external attempt; no cost derivation exists | **READY** for counts, **MAJOR GAP** for cost |
| Monthly aggregation | `seo_usage_totals` RPC groups in SQL with a stable shape; no billing-period concept yet | **READY** for arbitrary windows, **MINOR GAP** for period boundaries |
| Funding exposed on read | `seo_usage_totals` does not select or group `funding_source`; `UsageReportDto` has no funding dimension | **MINOR GAP** for operator-funded-only aggregation |

Per-entitlement suitability:

| Entitlement | Count reliably? | Granularity OK? | Funding known? | Account known? | Project known? | Deterministic? | Monthly agg? | Rating |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AI text allowance | Yes | Tokens or aggregated generations | Yes | Yes | Yes | Yes | Yes | **READY** |
| AI image allowance | Yes | Exact | Yes | Yes | Yes | Yes | Yes | **READY** |
| Embeddings (bundled) | Yes | Needs bundling | Yes (operator) | Yes (back-filled) | Yes | Yes | Yes | **READY** |
| DataForSEO allowance | Yes | Needs aggregation | Yes | Yes | Yes | Yes | Yes | **READY** |
| Media allowance | Yes | Exact | Yes | Yes | Yes | Yes | Yes | **READY** |
| Tracked keywords (state) | No - state, not events | n/a | n/a | Yes | Yes | n/a | n/a | **NOT SUITABLE** (use table counts) |
| Projects (state) | No - state | n/a | n/a | Yes | n/a | n/a | n/a | **NOT SUITABLE** (use table counts) |
| Storage | No metering | n/a | n/a | n/a | n/a | n/a | n/a | **MAJOR GAP** |

Conclusion: the ledger is **READY** for the monetizable consumption resources.
The two structural gaps for a *commercial* read are (a) `funding_source` is not
exposed, and (b) period boundaries are not modeled. Both are additive.

---

## 10. Scope Analysis

One matrix, one recommended scope per entitlement. The design rule is: **do not
define the same entitlement on multiple scopes unless there is a clear reason**
(e.g. account-level "money" vs project-level "state").

| Entitlement | Account | Project | User | Recommended |
| --- | --- | --- | --- | --- |
| AI text allowance | Yes | No | No | **Account** (shared money; matches admission account scope) |
| AI image allowance | Yes | No | No | **Account** |
| Embeddings allowance | Yes | No | No | **Account** (bundled with AI/knowledge) |
| DataForSEO allowance | Yes | No | No | **Account** |
| Media allowance | Yes | No | No | **Account** |
| Feature: API access | Yes | Possible override | No | **Account** (with optional project override) |
| Feature: MCP access | Yes | No | No | **Account** |
| Feature: AI editing | Yes | No | No | **Account** |
| Feature: publishing destinations | No | No | No | **Project count as feature limit** (state) |
| Project count | Yes | n/a | n/a | **Account** (optional product decision) |
| Tracked keywords | No | Yes | No | **Project** (state) |
| Scheduled jobs | No | Yes | No | **Project** (count/feature) |
| API rate limit (abuse) | No | Yes | Yes | **Key/User** (technical, not entitlement) |
| Personal API keys | No | No | Yes | **User** (identity, not entitlement) |

Notes:

- **Account** is the billing boundary. There is exactly one account per owner
  (`seo_accounts_owner_unique`), and no account-member table exists yet
  (`20260101000011_accounts.sql:31`). Shared allowances therefore mean "one
  user's workspace"; a true multi-seat account would need the account-member
  model first (section 22).
- **Project** is the right scope for *state* (tracked keywords, schedules,
  integrations). It matches P9/P11's per-project protection and prevents one
  project from consuming the whole account's allowance - though that is a
  technical concern, already handled.
- **User** should be reserved for identity and technical rate limiting, not for
  product allowances, because allowances in this product are workspace-level.

**Avoid:** defining, say, an AI allowance at both account and project scope. The
account is the money scope; the project is the state scope. Mixing them creates
double enforcement and confusing UI.

---

## 11. Plan Architecture

Do not invent Free/Pro/Agency. Define what a plan must be able to *express*.

A plan needs two axes:

```text
Plan
 ├── feature entitlements   (boolean / enumerated capabilities)
 │    ├── ai_editing
 │    ├── api_access
 │    ├── mcp_access
 │    ├── publishing_destinations (count)
 │    └── advanced workflows
 │
 ├── resource allowances    (numeric, per period, operator-funded only)
 │    ├── ai_generation
 │    ├── ai_image
 │    ├── ai_embedding (bundled)
 │    ├── dataforseo_research (aggregated)
 │    └── media
 │
 └── state limits           (numeric, instantaneous, not per period)
      ├── projects
      └── tracked_keywords (per project)
```

Modeling options:

| Option | Verdict |
| --- | --- |
| Plain feature flags | Necessary but insufficient (no amounts) |
| Numeric limits | Necessary for allowances and state |
| Resource policies | Correct abstraction: a policy maps `resource` -> `{ mode, value, period }` |
| Credits | Optional; not needed if allowances are in product units |
| Combination | **Recommended**: feature flags + resource policies (numeric with period), no credits in v1 |

Recommended plan shape:

- `feature` entitlements as booleans/enums;
- `resource_policy` rows as `{ resource, limit, period, funding: 'operator_funded' }`;
- `state_limit` rows as `{ object, limit }` (no period);
- no plan references inside P9/P11; the plan resolves to an effective ceiling.

---

## 12. Entitlement Architecture

Conceptual layer above P9/P11:

```text
                 Request
                    |
        +-----------v-----------+
        |  Technical Resource   |   P9/P11 (unchanged, plan-unaware)
        |  Protection           |
        +-----------+-----------+
                    |
        +-----------v-----------+
        |  Entitlement Policy   |   future: feature + allowance + state
        +-----------+-----------+
                    |
        +-----------v-----------+
        |  Usage / Metering     |   seo_usage_events (unchanged)
        +-----------------------+
```

Placement of the future entitlement policy:

| Concern | Where | Why |
| --- | --- | --- |
| Feature flags | Service/account layer + DB plan tables | Checked before starting a feature |
| Resource allowances | DB policy table + resolver consulted by admission | Must be atomic with the P9/P11 decision |
| Effective ceiling | Admission helper (app) | `min(technical_ceiling, plan_allowance)` |
| Atomic enforcement | Existing DB trigger/function | Reuse P9/P11; no new race |
| Period usage totals | SQL aggregation over the ledger | Already exists (`seo_usage_totals`) |

**Do not overload P9/P11:**

- `seo_resource_limits` stays a technical table; it must not gain plan/subscription
  columns and `seo_admit_job`/`seo_admit_resource` must not become plan-aware
  (`docs/p11-resource-protection.md` section 16).
- The entitlement layer is a **separate policy** joined at resolution. The
  cleanest enforcement is for the entitlement resolver to compute the effective
  ceiling and pass it to the existing admission primitive as an optional
  parameter, or to seed/override the ceiling for the request only.
- Feature entitlements are evaluated **before** admission (a feature that is not
  in the plan should not reach the technical layer at all, and must produce a
  distinct UX state - section 18).

A key decision for P13: **allowance enforcement can be either (a) a lowered
ceiling per request, or (b) a period-to-date check resolved pre-admission.**
(a) is simpler and race-free; (b) needs a consistent read of period totals.
Recommendation: start with (a) plus a period gate that is re-checked in the
database if strictness is required.

---

## 13. Policy Data Model

Conceptual entities (no migration is written):

| Entity | Purpose | Mutable? | Per-account override? | Versioned? |
| --- | --- | --- | --- | --- |
| `plans` | Named plan + feature flags baseline | Rarely | n/a | Yes |
| `plan_entitlements` | `plan` -> feature entitlements | Rarely | n/a | Yes |
| `resource_policies` | `plan` -> resource allowance (`value`, `period`, `funding`) | Rarely | n/a | Yes |
| `state_limits` | `plan` -> state caps (projects, tracked keywords) | Rarely | n/a | Yes |
| `account_entitlements` | Account's current plan + overrides | On plan change | Yes | Reference to version |
| `account_overrides` | Per-account grant/limit (enterprise, promo, support) | Yes | Yes | Yes |
| `usage_periods` | Materialized period boundaries/totals (optional) | Append/roll | n/a | n/a |

Design rules:

- **Immutable:** plan definitions and their version history. A plan change binds
  an account to a new plan version; historical usage always references the
  policy that was in force when it was consumed.
- **Dynamic:** account's active plan, overrides, promotional grants.
- **Per-account overrideable:** the account→plan binding, plus explicit
  `account_overrides` for enterprise/promo/support (section 19).
- **Derived, not stored:** cost. It is computed from usage facts + pricing rules
  so historical usage stays truthful when provider prices change (this is why
  `seo_usage_events` deliberately stores no cost).
- **Not needed in v1:** `usage_periods` can be computed from `occurred_at` +
  period config until the volume justifies materialization.

---

## 14. Plan Changes

Scenarios and required behavior:

| Scenario | Required behavior |
| --- | --- |
| Free -> Pro | Increase entitlements/allowances from the effective date; do not rewrite historical usage |
| Pro -> Agency | Same, upward |
| Downgrade | New, lower effective ceilings apply going forward; existing state (projects/keywords) is grandfathered or marked over-limit, never silently deleted |
| Cancellation | Drop to base/free effective ceiling at period end; state preserved |
| Trial expiration | Same as cancellation, at trial end |
| Account suspension | Reduce effective ceiling to 0 / disable features via an account flag; technical protection still runs |
| Promotional allowance | Time-bounded `account_override` grant |
| Manual admin override | Per-account override with audit trail |

Can a plan change without corrupting usage data?

**Yes**, because usage is append-only and independent of plans. A plan change
only changes the *effective ceiling* and feature flags from a timestamp. The
ledger is never rewritten. The only risk is if enforcement read the *current*
plan retroactively against *past* usage; that must be avoided by evaluating
against the plan in force for the period being enforced.

What happens mid-period when policy changes?

- The safe rule: **a plan change takes effect at a boundary**, or, if immediate,
  the higher of "new allowance from period start" and "old usage" is used to
  avoid double-charging or accidental lockout. Recommended: prorate or reset at
  the boundary; grandfather state that exceeds the new cap.
- The important invariant: **an account must never be retroactively punished for
  usage that was legitimate under its plan at the time.** That is why policy is
  versioned and usage references its period.

---

## 15. Usage Periods

Different resources need different period semantics. The critical distinction is
**state vs consumption**.

| Resource | Type | Recommended period |
| --- | --- | --- |
| AI text | consumption | monthly (or rolling 30d) |
| AI image | consumption | monthly |
| Embeddings | consumption (bundled) | monthly |
| DataForSEO | consumption | monthly |
| Media | consumption | monthly |
| Tracked keywords | **state** | none (instantaneous cap) |
| Scheduled jobs | state/feature | none or per-project cap |
| Projects | state | none (instantaneous cap) |
| API/MCP | feature + rate | rate window (existing), feature on/off |

Explicitly: **a project with 10,000 tracked keywords is not the same as 10,000
keyword-research requests.** The first is stored state (row counts), the second
is ledger consumption (events). They must use different mechanism and UI.

Findings:

- Monthly is the most understandable; rolling 30d is smoother but harder to
  explain. No billing-period concept exists today, so v1 should use **calendar
  month or rolling 30 days as a pure product choice** (PRODUCT DECISION).
- Lifetime and per-project-lifetime periods are not recommended for
  consumption; they remove the recurring revenue structure and complicate
  grandfathering.
- Period boundaries must be defined before enforcement; the ledger's
  `occurred_at` already supports any window via `seo_usage_totals`.

---

## 16. Credits vs Raw Usage

Comparison for the monetizable resources:

| Dimension | Raw usage (`10,000 keyword lookups`, `500 AI generations`) | Credits (`10,000 credits`) |
| --- | --- | --- |
| Transparency | High - matches the resource | Low - opaque abstraction |
| Simplicity (UX) | Good if units are product-level | Very simple once learned |
| Economics | Direct; provider variability visible | Requires a conversion rate per resource |
| Provider cost variability | Handled by re-pricing the unit | Requires changing conversion whenever provider changes |
| Future provider swaps | Unit can stay ("research credits") | Stable, but conversion must be re-derived |
| User comprehension | Familiar | Requires education |
| Abuse resistance | Same (technical layer enforces) | Same |
| Reporting | Natural from the ledger | Requires conversion in reporting |
| Implementation complexity | Low (policy rows over existing units) | Medium (ledger + conversion + balance) |

Assessment per category:

- **AI image:** credits fit naturally (one image = one credit). Either works;
  credits add nothing over a per-image allowance.
- **DataForSEO:** raw usage in an aggregated product unit ("research credits"
  is itself a product unit, not a separate currency) is best. A true fungible
  credit system would need a conversion rate that tracks DataForSEO pricing.
- **AI text:** raw tokens are accurate but opaque; generations are simple but
  cost-variable. Either can be implemented as an allowance without a separate
  currency.
- **Embeddings / infra:** raw usage, bundled.

**Recommendation:** use **product-unit allowances over raw usage**, not a
fungible credit currency, for v1. A "keyword research credit" is a *product
unit*, not a wallet; it maps to one or more raw events but is expressed directly
as an allowance. Introduce a true credit/wallet system only if the product later
needs pre-paid bundles or cross-resource fungibility. Credits add a conversion
layer that must change whenever provider economics change (section 18), with no
v1 benefit.

---

## 17. Provider Cost Variability

An entitlement must not be hard-coded to `openai_xxx` / `dataforseo_xxx`. The
separation must be:

```text
provider         = who actually executes the call (openai, dataforseo, gsc, ...)
product resource = what the customer buys (ai_generation, research, ...)
```

Events to assess:

| Event | Correct response |
| --- | --- |
| OpenAI model changes | Product resource (`ai_generation`) unchanged; pricing/token conversion, if any, updates in policy data |
| AI provider changes (swap OpenAI) | `provider` on events changes; product resource unchanged; `PROVIDER_IDS`/catalog already abstracts this |
| DataForSEO pricing changes | Product resource unchanged; only cost derivation updates |
| New provider added | Register adapter + descriptor; product resource vocabulary already covers the class or gets a reviewed extension |
| Operator keys replaced | Funding attribution remains `operator_funded`; no product change |
| BYOK added/removed | Funding attribution flips `byok` <-> `operator_funded`; allowance policy already keyed on funding |

Findings:

- The resource vocabulary (`RESOURCE_KINDS`) is already provider-neutral and is
  the correct join point for entitlements.
- The usage `provider` field is open and expected to change; entitlements must
  key on resource, never provider.
- Because no cost is stored, provider price changes never corrupt history; a
  future cost derivation reads current pricing against historical usage. That is
  a deliberate strength for variability.
- **P13 must not put provider ids in plan/entitlement tables.** Only resource
  keys. If a specific provider must be excluded from an allowance, that is a
  policy on the resource with a provider exception, not a provider-named plan.

---

## 18. UI / Customer Experience

Entitlements must be visible and, crucially, **technical denials and entitlement
denials must look different**.

Minimum surfaces:

### Account

- Current plan (name only; no pricing UI in P12 scope).
- Usage vs allowance per monetizable resource, per current period.
- Funding/BYOK status (is the account using its own keys?).
- Billing period (once defined).
- Note: no Account settings/plan page exists today. The account nav
  (`TOP_NAV` in `apps/web/src/App.tsx:101-107`) has Overview / Projects /
  Connections / API keys / Usage. A plan/usage surface would extend this, not a
  new system. The existing `Usage` view already serves both scopes through one
  DTO (`apps/web/src/views/Usage.tsx`; `UsageReportDto`).

### Project

- Project-specific state limits (tracked keywords if capped).
- Scheduled resources and integrations.
- No money-based entitlement should be shown at project level (account scope).

### Feature surfaces

```text
Feature unavailable
        |
        +-- technical protection  -> "busy, try again later" (429, transient)
        |
        +-- entitlement           -> "not in your plan / allowance reached" (persistent)
```

The two states must be **visually and semantically distinct**:

- Technical denial already maps to HTTP 429 with
  `{ code: resource_limit | resource_concurrency | queue_limit, details: { resource, scope } }`
  and the web already renders it. It is transient and must not say "upgrade".
- Entitlement denial is persistent and actionable ("enable" / "increase plan").
  It should use a **distinct error code** (e.g. a future `entitlement_*`) so the
  UI never tells a user to retry something that will never succeed, and never
  tells a user to upgrade for a temporary queue condition.

Additional findings:

- The current `Usage` UI says "Counts only - no pricing or cost", which is the
  honest baseline. Showing allowances adds a second column ("of N") but must
  keep the same truthfulness.
- Admin has a read-only `AdminUsage`; `AdminAccounts` explicitly states "No
  billing or plan data is modeled." Plan administration would extend admin, not
  replace it.
- No UI may enforce entitlement client-side; the server is the boundary.

---

## 19. Admin Overrides

A future monetization layer needs admin override capability for:

- custom enterprise limits;
- promotional allowances (time-bounded);
- support adjustments;
- temporary resource grants;
- internal/test accounts.

Recommendations:

- Model overrides as per-account rows (`account_overrides`), not by editing plan
  definitions. This keeps plans immutable/versioned and makes an override
  explicit, auditable and reversible.
- Overrides should be additive to the effective-ceiling resolution:
  `effective = min(technical_ceiling, plan_allowance, account_override?)` with
  an override able to *raise the plan allowance* (never the technical floor).
- Every override needs an actor and a timestamp (audit). Internal/test accounts
  are a flag, not a special plan name.
- Admin override is **part of the future entitlement model**, and admin UI is
  not built in P12.

---

## 20. Abuse / Gaming

How a user could game product entitlements, and the nature of each problem.

| Loophole | Nature | Notes |
| --- | --- | --- |
| Multiple projects | **Product-policy problem** | Account allowance already covers all projects (P11 account scope). Only state limits (project count) are affected. |
| Multiple users | **Product-policy problem** | Requires account-member model; today one user = one account. Multi-seat abuse is a product decision. |
| API / MCP | **Technical + policy** | Rate limited; if API is a feature entitlement, must be checked server-side (already keyed by API key/scope). |
| Scheduled jobs | **Technical (handled)** | Their work runs through P9; retries do not multiply reservations. |
| BYOK | **Not a loophole for cost** | BYOK removes operator cost; a user using their own key legitimately. Still subject to feature/state limits. |
| Retries | **Technical (handled)** | UPDATE not INSERT in P9; provider re-calls emit new facts, which is correct. |
| Cancellations | **Technical (handled)** | Release capacity; do not consume allowance for work not done. |
| Account creation | **Product/security decision** | Open signup + server-funded keys is bounded by technical ceilings, but account-splitting to farm free allowances is a policy/identity problem. |
| Duplicated resources | **Product-policy** | Duplicating a project to reset a state limit. |

Key instruction from the spec, and the finding: **account splitting/multi-account
abuse must not automatically be solved with heavy identity requirements.**
Mark those as **product/security decisions**:

- Free-allowance farming via new accounts is a **PRODUCT/SECURITY DECISION**.
  Options include generous technical-only free tier, signup friction, or
  verification - but these are product choices, not something the entitlement
  schema should silently enforce.
- The technical floors (P9/P11) already bound the damage a single or many new
  accounts can do at the infrastructure level, independent of entitlement.

Most consumption loopholes are already **technical problems that are solved**
(P9/P11). The remaining ones (project/user multiplication, account creation) are
**product-policy problems** and must be decided, not coded around.

---

## 21. Monetization Candidate Ranking

Ranked using: direct cost, user value, predictability, understandability, abuse
risk, metering readiness, implementation complexity, future flexibility.

| Rank | Candidate | Direct cost | Value | Predictability | Understandability | Abuse risk | Metering | Complexity | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | DataForSEO research allowance | High | High | Medium | Medium (needs product unit) | High | Ready | Medium | **Tier A** |
| 2 | AI text allowance | High | Very high | Medium | Medium | High | Ready | Medium | **Tier A** |
| 3 | AI image allowance/credits | Medium | High | High | Excellent | Medium | Ready | Low | **Tier A** |
| 4 | API/MCP feature entitlement | Low | Medium-high | High | Excellent | Medium | n/a | Low | **Tier A** (feature) |
| 5 | Embeddings (bundled) | Low | Indirect | High | Weak standalone | Medium | Ready | Low | **Tier B** |
| 6 | Media (stock) allowance | Low | Medium | High | Good | Low | Ready | Low | **Tier B** |
| 7 | Projects / tracked keywords state limits | Low | Medium | High | Good | Medium | State (not ledger) | Low | **Tier B** |
| 8 | Concurrency tiers | Low | Medium | High | Good | Low | Existing P11 | Low | **Tier B** |
| 9 | Storage/media quota | UNKNOWN | Medium | UNKNOWN | Good | Low | Major gap | High | **Tier B/C** |
| 10 | Publishing destinations | ~0 operator | Medium | High | Good | Low | Ready | Low | **Tier B (feature)** |
| 11 | Google reads | ~0 operator | n/a | n/a | n/a | Low | Ready | n/a | **Tier C** |
| 12 | Jina/Cohere/Qdrant | Operator internal | n/a | n/a | n/a | Low | Unmetered | n/a | **Tier C** |
| 13 | Queue/rate protections | n/a | n/a | n/a | n/a | n/a | n/a | n/a | **Tier C** |
| 14 | Auth/internal DB | ~0 | n/a | n/a | n/a | n/a | n/a | n/a | **Tier C** |

### Tier A - strong first monetization candidates

Operator-funded, high-value, already metered: DataForSEO research, AI text, AI
image, and API/MCP as feature entitlements.

### Tier B - interesting but later

Embeddings (bundled), media, state limits (projects/tracked keywords),
concurrency tiers, storage (blocked on metering), publishing destinations as a
feature.

### Tier C - do not monetize / technically protect only

Google reads, knowledge infra, queue/rate protections, authentication, internal
DB operations.

---

## 22. Implementation Readiness

What must happen before P13. Classified P0 (blocks entitlement implementation),
P1 (needed for reliable monetization), P2 (improvement), P3 (later).

### P0

| Item | Why |
| --- | --- |
| **Product decisions**: which resources are sold, plan shape, BYOK exemption, period type, free/paid split | Nothing can be built without these; the technical layer cannot guess policy |
| **Effective-ceiling contract**: define how a plan limit is passed to P9/P11 admission without making them plan-aware | Determines the entire enforcement shape |

### P1

| Item | Why |
| --- | --- |
| **Expose `funding_source` on the usage read surface** and allow operator-funded-only aggregation | Allowances must count only operator-funded consumption for BYOK exemptions |
| **Period accounting** (define month/rolling + window filtering in reporting and enforcement) | Required for monthly allowances |
| **Policy storage** (plans, entitlements, account binding) | Holding the decisions |
| **Failure policy for usage** (whether `success=false` events count) | Wrong choice mischarges users |
| **Entitlement vs technical error differentiation** (distinct code/UX) | Prevents misleading users |
| **Account-member model** if multi-seat plans are intended | One user = one account today (`seo_accounts_owner_unique`) |

### P2

| Item | Why |
| --- | --- |
| Provider/session-based pricing derivation (usage + pricing rules = cost) | Needed only for overage/COGS reporting |
| State-limit storage (projects/tracked keywords) if capped | Only if the product gates them |
| Materialized `usage_periods` | Performance at scale |
| Denial visibility UI (`seo_resource_denials` has no surface today) | Abuse observability |
| Admin override tables/audit | Enterprise/support |
| Distributed rate limiting | Existing P2 debt; does not affect DB admission |

### P3

| Item | Why |
| --- | --- |
| True credits/wallet system | Only if the product later needs pre-paid/fungible credits |
| Overage / pay-as-you-go | After cost derivation and pricing decisions |
| Cost forecasting/reporting | Later |
| Storage metering | Only if storage becomes a product dimension |

Prerequisites already satisfied: funding attribution (`funding_source`), scope
(account/project/user present and back-filled), admission primitives,
append-only ledger, aggregation RPC.

---

## 23. Recommended Commercial Model

**Recommended model**

```text
Base plan
  +-- feature entitlements        (API, MCP, AI editing, destinations)
  +-- operator-funded allowances  (AI text, AI image, DataForSEO, media, embeddings bundled)
  +-- state limits                (projects, tracked keywords - only if the product chooses)
  +-- technical protection        (P9/P11 - always, plan-independent)

Enforcement
  effective_ceiling = min(technical_ceiling, plan_allowance)
  BYOK consumption  -> exempt from the allowance (still bounded technically)

Optional later
  +-- concurrency tiers           (lower the existing *_inflight ceiling)
  +-- overage / pay-as-you-go     (only after cost derivation)
```

Why this model:

- It reuses the existing metering, scope and admission; it does not rewrite P9/P11.
- It charges only for cost the operator actually incurs (operator-funded).
- BYOK is honored: the user pays their provider, so they are not charged again.
- It keeps feature access and resource amounts separate, matching their
  different UX states.
- It is data-driven: a plan is policy rows, so plan changes need no code change.

**Alternative 1 - pure feature tiers (Free/Pro/Agency with fixed caps).**
Less suitable because it hard-codes an amount per tier and does not naturally
honor BYOK; changing a cap requires touching plan definitions/rows per tier, and
it cannot express "same plan, more usage".

**Alternative 2 - credit/wallet currency.** Less suitable for v1 because it
adds a conversion layer that must track provider cost changes (section 17),
reduces transparency, and provides no benefit over product-unit allowances until
pre-paid bundles or cross-resource fungibility are actually required.

---

## 24. P13 Recommendation

Concrete implementation brief for P13 (implementation itself is out of scope).

1. **Entitlement entities needed**
   - `plans` (name, feature flags baseline, version)
   - `plan_entitlements` (plan -> feature on/off)
   - `resource_policies` (plan -> `{ resource, allowance, period, funding }`)
   - `state_limits` (plan -> `{ object, limit }`) - only if the product caps state
   - `account_entitlements` (account -> plan binding, effective dates)
   - `account_overrides` (per-account grants/limits with audit)
   - Optional `usage_periods` (materialized; can be computed first)

2. **Resource policies needed** (v1)
   - `ai_generation` allowance (operator-funded)
   - `ai_image` allowance (operator-funded, per-generation)
   - `dataforseo_research` aggregated allowance (operator-funded)
   - `media` allowance (operator-funded, bundled)
   - `ai_embedding` bundled into AI/knowledge allowance
   - Feature flags: API, MCP, AI editing, publishing destinations
   - State limits: projects, tracked keywords (PRODUCT DECISION)

3. **Resources monetized in v1**
   - AI text, AI image, DataForSEO research (as an aggregated product unit),
     media; plus feature entitlements for API/MCP/AI editing.
   - Embeddings bundled, not sold separately.

4. **Resources technically protected but free/unlimited (not monetized)**
   - Google GSC/GA4/Ads reads, WordPress/X publishing, queue/rate/concurrency
     protection, authentication and internal DB.

5. **Usage events to adjust**
   - No vocabulary change required.
   - Add `funding_source` to the read/aggregate surface (`seo_usage_totals` and
     `UsageReportDto`) so allowances can count operator-funded only.
   - Add period-boundary support to the read path.

6. **Scope of each entitlement**
   - Account: all money-based allowances and feature flags.
   - Project: state limits (tracked keywords, schedules).
   - User: personal API keys and technical rate limits only.

7. **BYOK handling**
   - BYOK is exempt from operator-funded allowances; it remains subject to
     technical protection, feature entitlements and state limits.

8. **Operator-funded handling**
   - All operator-funded consumption counts against the account allowance for
     the current period, across all projects.

9. **Where enforcement runs**
   - In the database, reusing `seo_admit_job`/`seo_admit_resource`; the
     entitlement resolver computes `effective_ceiling = min(technical, plan)` and
     passes it in. Feature entitlements are checked in the service/account layer
     before admission. P9/P11 stay plan-unaware.

10. **Minimum UI**
    - Account: current plan (name), usage vs allowance per resource, funding/BYOK
      status, period. Extend the existing `Usage` view.
    - Distinct UI states for technical denial (transient, retry) vs entitlement
      denial (persistent, enable/increase).
    - No client-side enforcement.

11. **Reuse from P9/P11**
    - `seo_resource_limits` (technical floor), `seo_admit_job` and
      `seo_admit_resource` (atomic enforcement), `ResourceAdmissionService`
      (single sync seam), `seo_usage_events` + `seo_usage_totals` (metering),
      the resource vocabulary, funding attribution and the API error shape.

12. **Migrations required (P13)**
    - Plans/entitlements/policies/account-binding/overrides tables (+ RLS).
    - Extend `seo_usage_totals` and the read DTO for `funding_source` and period.
    - No change to P9/P11 enforcement columns or signatures beyond an optional
      effective-ceiling parameter.
    - No billing/pricing/Stripe tables.

13. **Tests required (P13)**
    - Entitlement resolution: plan -> effective ceiling; min with technical.
    - Enforcement: plan lower than technical -> denial at plan; plan higher ->
      technical still wins; BYOK exempt; operator-funded counted.
    - Period aggregation with funding filter.
    - Feature entitlement denial is a distinct error from technical denial.
    - Plan change mid-period does not rewrite history or retroactively punish.
    - Free-database smoke: entitlement tables, RLS, effective-ceiling behavior.

---

## Acceptance Criteria Check

- [x] All P10/P11 resources assessed for monetizability (section 2, 4, 5).
- [x] Technical protection, usage metering and product entitlement explicitly
      separated (section 3).
- [x] BYOK vs operator-funded explicitly assessed (section 6).
- [x] Account/project/user scope determined per entitlement (section 10).
- [x] Resource units defined or marked as product decision (section 8).
- [x] Existing `seo_usage_events` suitability assessed (section 9).
- [x] Credits vs raw usage investigated (section 16).
- [x] Provider cost variability considered (section 17).
- [x] Technical resources distinguished from customer-facing product resources
      (sections 8, 17).
- [x] Possible entitlement bypasses investigated (section 20).
- [x] Future plan changes investigated (section 14).
- [x] Admin overrides considered (section 19).
- [x] UI/UX for technical denial vs entitlement denial described (section 18).
- [x] One clearly recommended commercial architecture chosen (section 23).
- [x] P0/P1/P2/P3 implementation debt named (section 22).
- [x] Concrete P13 recommendation given (section 24).
- [x] No code/schema/UI/billing/pricing implementation performed.

---

## Constraints Honoured

No migrations, schema changes, API changes, UI changes, plans, subscriptions,
Stripe/payment provider, checkout, pricing UI, billing UI, entitlement
enforcement or feature tiers were added. No product code was changed. No
monetary amount was invented; every amount is **External pricing/configuration
required**, and every question the codebase cannot answer is marked
**UNKNOWN - requires product decision**. P9/P11 remain plan-unaware technical
resource protection; the proposed entitlement layer sits above them.
