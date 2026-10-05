# P10 - Resource Economics & Monetization Recon

Status: **recon complete. Documentation only.** No migration, schema, API, UI,
contract, subscription, pricing, tier, entitlement or limit change was made to
produce this document.

Baseline: `003a9f6 feat(protection): bound and attribute background work (P9)`.
Migrations remain at **39**; no new migration.

P9 delivered the technical Resource Protection Foundation
(`seo_resource_limits`, `seo_resource_denials`, `seo_admit_job`,
`ResourceAdmissionService`, `GuardedJobStore`, atomic queue admission). P10 asks
the product/economics question that P9 deliberately left open:

> Which resources does Old Skool SEO actually consume, which of them are
> expensive or scarce, and can future monetization be built on top of P9
> without redesigning it?

Every claim is grounded in a reachable `file:line`. Where a vendor price would
be required to turn usage into money, this document marks it **External
pricing/configuration required** and does not invent a number. Where the codebase
cannot answer a question, it is marked **UNKNOWN - requires product decision**.

---

## 1. Executive Summary

1. The system consumes **six families** of external/expensive resources:
   Google API reads (GSC/GA4/Ads), DataForSEO, OpenAI (text/image/embeddings),
   Cohere rerank, Jina fetch, and Qdrant vector infra - plus internal job/queue
   capacity and Supabase storage.
2. **Operator financial exposure is concentrated in the server-funded env keys**:
   `OPENAI_API_KEY` (text/image), `EMBEDDINGS_*`/`OPENAI_API_KEY` (embeddings,
   always server-funded), `KNOWLEDGE_RERANKER_API_KEY` (Cohere),
   `UNSPLASH_ACCESS_KEY`, `JINA_API_KEY`, `QDRANT_*`, and the
   `DATAFORSEO_*` env fallback. Google reads and WordPress/X publishing are
   funded by the user's own account/credentials
   (`apps/api/src/services/aiService.ts:169-172`,
   `apps/api/src/providers/knowledge/embedding.ts:111-136`,
   `apps/api/src/config.ts:56-118`).
3. **Economics vs protection.** Only a subset of resources is genuinely
   expensive to the operator (AI, embeddings, DataForSEO env fallback, Jina,
   Qdrant). Google API reads are quota-bound but user-funded: they need
   *technical protection*, not monetization.
4. **Usage metering is mature but post-hoc.** `seo_usage_events` records AI,
   DataForSEO, Google, media, publishing and job facts, and a DB trigger
   back-fills `account_id` from `project_id`, so account-level aggregation is
   actually complete at the row level (`supabase/migrations/20260101000031_usage_events.sql:109-121`).
   It cannot prevent consumption - that is admission's job.
5. **P9 protects the queue, not every expensive operation.** Admission is a
   `BEFORE INSERT` trigger on `seo_sync_jobs`
   (`supabase/migrations/20260101000039_resource_protection.sql:196-199`), so it
   covers every enqueued path. It does **not** cover expensive work that runs
   synchronously inside an HTTP request (Composer/Designer/Writer planner, content
   AI edit, `?with_ai=1`, integration/publisher test calls). Those are the largest
   remaining admission gaps.
6. **P9 is sufficiently generic to carry a future plan/entitlement layer.** Its
   limits are data (`seo_resource_limits`), enforced atomically, and independent
   of any plan concept. Adding entitlements is an additive resolver, not a
   redesign - but P9's key is `(scope, resource)` with a single `max_value`, so a
   single resource cannot yet hold both a technical and a product ceiling without
   a new policy dimension (section 7C).
7. **Recommended P11 is protection-completion, not monetization**: close the
   synchronous admission gaps, add funding attribution (BYOK vs operator), extend
   admission to per-resource ceilings, and close the remaining validation /
   limiter gaps. A plan/entitlement layer becomes safe to add only afterwards
   (section 14).

---

## 2. Complete Resource Inventory

`Queued` = creates a `seo_sync_jobs` row executed by the worker (P9-admitted).
`Sync` = the HTTP handler blocks on the provider call (not P9-admitted unless it
first enqueues).

| Resource | Code path | Trigger | Provider | Existing metering | Existing protection |
|---|---|---|---|---|---|
| GSC sync | `apps/api/src/jobs/executors.ts:145-247` | `gsc_sync` job / `POST .../gsc/sync` | Google (user OAuth) | `google/gsc_request` | P9 queue admission; route caps days 7/28/90 |
| GA4 sync | `executors.ts` (`analytics_sync`), `services/googleAnalyticsService.ts:49-63` | `analytics_sync` job | Google (user OAuth) | `google/ga4_request` | P9 queue admission |
| Ads report | `services/googleAdsService.ts:52-64`, `providers/googleAds/googleAdsClient.ts:338-472` | `GET .../ads/*` | Google (user OAuth) | `google/ads_request` | route report limit 100 |
| DataForSEO SERP/rank | `providers/dataforseo/dataForSeoClient.ts:326-371` | `dataforseo_rank_sync`, `serp_retrieval` | DataForSEO (BYOK/env) | `dataforseo/*`, `serp_request` | P9 queue admission; keyword caps 100/50; 40 req/min client pacing |
| DataForSEO keyword/competitor | `dataForSeoClient.ts:382-568` | `dataforseo_keyword_research`, `competitor_research` | DataForSEO (BYOK/env) | `dataforseo/*` | P9 queue admission; seeds 20 / competitors 3 |
| AI text (chat/generate/writer/agent) | `services/aiService.ts`, `agents/writer/*`, `agents/designer/*` | `content_generate`, `content_write`, `agent_design`, sync composer/designer/writer | OpenAI (BYOK/env) | `ai/chat|generate` tokens | P9 for queued; per-call token caps; **sync paths unadmitted** |
| AI embeddings | `providers/knowledge/embedding.ts:111-136`, `services/embeddingService.ts` | `knowledge_index/reindex/source_ingest` | OpenAI/compatible (env only) | `ai/embed` input_token | P9 queue admission; **always operator-funded** |
| AI image | `providers/media/openaiMedia.ts:78-126`, `executors.ts` (`content_images`) | `content_images`, `agent_design` | OpenAI (BYOK/env) | `media/image_generation` | P9 queue admission; `n=1`, <=6/job |
| Media search | `providers/media/unsplash.ts:50-83` | `content_images`, image resolver | Unsplash (env only) | `media/asset` | P9 queue admission; limit 8; server-funded |
| Cohere rerank | `providers/rerank/cohereReranker.ts:46-60` | knowledge retrieval | Cohere (env only) | **none** | timeout/byte caps only |
| Jina fetch | `providers/jina/jinaKnowledgeFetcher.ts:83-100` | `knowledge_source_ingest/refresh`, discovery | Jina (env only) | **none** (job usage only) | P9 queue admission; 25 pages; server-funded |
| Qdrant vector ops | `providers/qdrantKnowledge.ts`, `knowledge/qdrantClient.ts` | `knowledge_*` jobs | Qdrant (infra) | **none** (embeddings metered) | P9 queue admission |
| Publishing | `providers/wordpress.ts`, `providers/social/xPublisher.ts` | `publish*` jobs / schedules | WordPress/X (user creds) | `publishing/publish_attempt` | P9 queue admission; user-funded |
| Storage uploads | `http/routes/media.ts:64-83`, `infra/knowledgeFileStorage.ts` | `POST .../media`, knowledge upload | Supabase Storage | none | size caps 12 MB / 10 MB |
| Background jobs | `jobs/*`, `worker.ts` | any enqueue path | platform | `job/job` (terminal) | P9 queued/running/rate ceilings |
| HTTP API surface | `http/routes/*`, `http/rateLimit*.ts` | any request | platform | n/a | process-local class rate limits |

Job-type → resource projection used by P9 denial reporting:
`apps/api/src/services/resourceAdmission.ts:36-64`.

---

## 3. Resource Economics

Classification reflects **implementation behaviour** and funding, not vendor
price lists. "Operator Cost" = can bill Old Skool SEO with no further user
action; "Abuse-only" = capacity that must be protected but that the operator does
not pay per unit.

| Resource | Class | Operator Cost | Basis |
|---|---|---|---|
| AI text generation | **HIGH** | yes (when no BYOK) | token-priced, unbounded call counts per run (`agents/writer`, `contentAiService`) |
| Writer deep / Designer run | **HIGH** | yes (when no BYOK) | up to 90 LLM calls; designer up to 32 steps with no aggregate budget (`packages/contracts/src/writer.ts:84`, `designer.ts:60`) |
| AI embeddings | **HIGH** | **always** | env-only, scales with chunk count, runs on every knowledge job (`embedding.ts:111-136`) |
| AI image generation | **MEDIUM/HIGH** | yes (when no BYOK) | `dall-e-3` per image; <=6/job (`openaiMedia.ts:88`) |
| DataForSEO keyword/competitor | **HIGH** | yes (env fallback) | per-task vendor billing; <=41 calls on KW4 (`dataSource.ts:153-162,430-437`) |
| DataForSEO rank sync | **HIGH** | yes (env fallback) | 100 keywords → 103-150 HTTP round-trips (`executors.ts:260`, `dataSource.ts:59-61`) |
| Jina fetch | **MEDIUM** | **always** | env-only; up to 25 pages/run (`jinaKnowledgeDiscovery.ts:29`) |
| Qdrant vector | **MEDIUM** | **always** | infra cost scales with points/collection (`qdrantKnowledge.ts`, `qdrantClient.ts:145`) |
| Cohere rerank | **MEDIUM/LOW** | **always** | env-only, per-retrieval (`cohereReranker.ts:46-60`) |
| Unsplash search | **LOW** | **always** | env-only; <=6/job (`unsplash.ts:77-80`) |
| GSC reads | **LOW** | no (user quota) | user OAuth (`gscDataSource.ts:224-262`) |
| GA4 reads | **LOW** | no (user quota) | user OAuth (`googleAnalyticsClient.ts:184-298`) |
| Ads reads | **LOW** | no (user quota) | user OAuth + operator dev token (`config.ts:56`) |
| WordPress/X publish | **LOW** | no (user creds) | user-owned (`providers/wordpress.ts`, `xPublisher.ts`) |
| Job queue / concurrency | **NONE/UNKNOWN** | internal | operator compute; protected by P9, not billed |
| HTTP API | **LOW** | internal | process compute; class rate limits |
| Storage/uploads | **LOW/MEDIUM** | yes (Supabase) | bounded by size caps; cost model UNKNOWN |

**Distinction that matters for pricing:**

- **Monetizable cost resources** (operator pays per unit): AI text/image,
  embeddings, DataForSEO env fallback, Jina, Cohere, Qdrant, storage.
- **Abuse-only capacity** (operator does not pay per unit): Google API reads,
  job queue depth/concurrency, HTTP request rate, publishing attempts.

A Google API call is not a monetization resource merely because Google has
quota - the user's own connected account funds it
(`docs/resource-protection-monetization-recon.md:145-147`).

---

## 4. Scope Analysis

Natural ownership (where a counter/quota logically belongs):

| Resource | Natural scope | Why | Current code scope |
|---|---|---|---|
| DataForSEO lookup | account/project | billed per task; a project is the natural cost owner, account is the payer | project+user; account back-filled from project |
| AI generation | account/project | token cost follows the payer; project for per-site budgets | account+project+user (`aiService.ts:191`) |
| AI embeddings | account/project | always operator-funded; must be capped at payer | project+user; account back-filled |
| AI image | account/project | same as generation | project+user; account back-filled |
| GSC / GA4 / Ads request | project/account | user-funded; project is where the data is used | project+user |
| Jina fetch / Cohere / Qdrant | account/project | operator infra consumed on behalf of a project | project (job) |
| Publishing attempt | project | the publication belongs to a project | project+user |
| Job queue | project **and** account | runaway backlog is both a project and a payer problem | P9 enforces both (`resource_protection.sql:148-190`) |
| API request | user/account | abuse surface follows the identity/key | user for session, IP for API keys |
| Projects / members / API keys | account | product/plan capacity | account (no cap) |

**Architecturally questionable current scopes:**

- **API-key requests (`/api/v1`, `/api/mcp`) are keyed by IP only**, not by key
  or account, so a shared IP merges unrelated callers
  (`apps/api/src/app.ts:229,234`).
- **`account_id` is not passed by most emitters**; the DB trigger back-fills it
  from `project_id`, which is correct for project-bound work but means
  account-level-only resources (e.g. account-wide API usage) have no direct
  meter.
- **Per-account limits do not exist yet**: P9's `seo_resource_limits` is keyed
  `(scope, resource)` globally, not per account row
  (`20260101000039_resource_protection.sql:38-65`).

---

## 5. Technical Protection vs Product Limits

Mandatory separation. **Technical limits are infrastructure policy and must not
automatically become pricing.**

| Resource | Technical limit (exists / needed) | Product-limit candidate | Reason |
|---|---|---|---|
| AI generation | per-call token caps (exists); per-account call budget **needed** | yes | operator cost when env-funded |
| AI embeddings | chunk caps (exists); per-project embed budget **needed** | yes | always operator cost |
| AI image | `n=1`, <=6/job (exists) | yes | operator cost when env-funded |
| DataForSEO | keyword/competitor caps (exists); per-account allowance **needed** | yes | vendor billing |
| Jina fetch | 25 pages (exists) | maybe | operator cost, small |
| Cohere rerank | timeout/byte caps (exists) | no | internal, low cost |
| Qdrant | none at provider seam (**needed**: index size) | maybe (bundled) | infra cost |
| GSC/GA4/Ads reads | days/rows/period caps (exists); days unbounded on `/jobs` (**gap**) | **no** | user-funded; never price |
| WordPress/X publish | none | maybe | user-funded; low cost |
| Job queue | P9 queued/running/rate (exists) | no (but "priority" could be later) | capacity, not cost |
| HTTP API | class rate limits (exists, process-local) | no | abuse protection |
| Projects / members / API keys | none | **UNKNOWN - product decision** | product surface, not cost |
| Storage/uploads | size caps (exists) | **UNKNOWN - product decision** | Supabase cost model unclear |

Do not invent new numeric ceilings where the codebase gives no basis; the
recommended product-limit values are **UNKNOWN - requires product decision** and
should be seeded as data, not code (section 7E).

---

## 6. Existing Usage / Metering Reconciliation

### 6.1 Metering vs admission

```text
metering   = measure what was consumed   (seo_usage_events, post-hoc)
admission  = decide what may be consumed (P9 trigger, pre-insert)
```

They are different mechanisms on purpose. The ledger can describe consumption
but cannot prevent it; P9 admission can prevent it but records only denials, not
usage. Both are needed and neither should absorb the other
(`docs/p9-resource-protection.md` sections 6-8).

### 6.2 What is metered

Vocabulary is the closed `@seo/contracts/usageEvent` set, extended by migrations
`36` and `37`: categories `ai, dataforseo, google, job, publishing, media`
(`packages/contracts/src/usageEvent.ts:47`,
`20260101000036_google_usage_vocabulary.sql:21-29`,
`20260101000037_google_ads.sql:68-71`); units include `request, task, keyword,
serp_request, gsc_request, ga4_request, ads_request, input_token, output_token,
image_generation, asset, publish_attempt, job`.

| Meter | Counts | When written | Billing-reliable? | Quota-suitable? | Scope |
|---|---|---|---|---|---|
| AI tokens | input/output tokens | after provider call | yes (facts) | as a base after cost rule | account+project+user (`aiService.ts:191`) |
| AI embeddings | input tokens | after each physical embed request | yes | base after rule | project+user; account back-filled (`embeddingUsage.ts:63-68`) |
| DataForSEO | tasks/SERPs/keywords | after call | yes | base after rule | project+user; account back-filled |
| GSC/GA4/Ads | request counts | after call | yes | **no** (user-funded) | project+user; account back-filled |
| Media | image generations/assets | after call | yes | base after rule | project+user (`mediaUsage.ts:48`) |
| Publishing | publish attempts | after attempt | yes | low value | project+user |
| Job execution | 1 per terminal job | at completion/terminal fail | yes | capacity evidence | project+created_by; account back-filled (`usageInstrumentation.ts:233-268`) |

All facts are append-only and idempotent via `source_id`
(`usageEvent.ts:320-324`). Failures are recorded with `success=false` where the
attempt was real.

### 6.3 What is not metered

- **Cohere rerank** - no usage event (`cohereReranker.ts`).
- **Jina fetch** - no provider usage event, only the enclosing job's fact.
- **Qdrant operations** - only the embeddings that feed them are metered.
- **Google OAuth token exchange** - unmetered.
- **Worker/server compute and storage bytes** - unmetered.

### 6.4 Reliability / gaps

1. **Cost is never stored** by design (`usageEvent.ts:20-22`) - correct for
   truthfulness, but there is no cost derivation yet.
2. **Funding source is not recorded** (no `keySource`/`funding` field): the
   ledger cannot distinguish "user's BYOK key paid" from "operator env paid" for
   the same operation. This is the single most important gap for economics.
3. **Account attribution** is back-filled at the DB layer, so it is present for
   project-bound facts; direct account-scoped facts (if added) would need the
   emitter to set it.
4. **Coverage gaps**: rerank, Jina, Qdrant, storage.
5. **No UI surfaces denials** (`seo_resource_denials` has no route/view).

---

## 7. P9 Compatibility

Inspected: `seo_resource_limits`, `seo_resource_denials`, `seo_admit_job`,
`ResourceAdmissionService`, `GuardedJobStore`, error mapping, metering.

Current P9 facts:
`seo_resource_limits(scope, resource, max_value, window_seconds)` with
`PK(scope, resource)` and `scope in (project, account)`
(`20260101000039_resource_protection.sql:38-65`); enforcement is a `BEFORE
INSERT` trigger on `seo_sync_jobs` using advisory locks
(`:94-199`); `ResourceAdmissionService` classifies job types to `ResourceKind`
and maps denials to 429 `queue_limit`/`resource_concurrency`/`resource_limit`
(`apps/api/src/services/resourceAdmission.ts:36-141`); `GuardedJobStore` wraps
the single enqueue seam (`apps/api/src/jobs/guardedJobStore.ts:34-50`).

**A. Can a technical limit exist independently of a subscription limit?**
Yes. `seo_resource_limits` has no plan/subscription concept; every row is pure
operational data. Nothing in the trigger or service references a plan.

**B. Can a plan/entitlement layer be added without rewriting core admission?**
Yes. Admission asks one question via `seo_resource_limit(scope, resource,
default)`. An entitlement resolver can compute the **effective** ceiling (plan
limit vs technical ceiling, min or plan-specific) and either seed/override
`seo_resource_limits` or be consulted by the trigger's helper. The
trigger/advisory-lock/error machinery stays.

**C. Can one resource have both a technical and a product limit?**
Not cleanly today: the key is `(scope, resource)` with one `max_value`, so a
technical ceiling and a product ceiling for the same pair collide. Adding a
`kind`/`policy` dimension (or an entitlement table joined at resolution) is the
minimal change. Recommended: keep `seo_resource_limits` as the technical floor
and add a separate entitlement/policy table resolved at admission.

**D. Can a product limit be per account/project?**
Yes, by adding `account_id`/`project_id` to a policy table (or a dedicated
entitlement table) and resolving it at admission. P9 today is global per scope;
per-account values are a data-model addition, not a logic rewrite.

**E. Can a plan change happen without migration/code change?**
Only if the effective limit is pure data. With the current global limits, a
per-account plan change requires either an update to a shared row (wrong) or a
new per-account policy table (small migration). Once that table exists, changing
a plan is data-only. This is the recommended shape.

**F. Where should subscription/entitlement logic live?**
In an **entitlement service** above admission; the database enforces the final
effective ceiling; the usage ledger stays untouched; the UI reads entitlements
and usage, never enforces them client-side.

**Verdict:** P9 is generic enough to carry monetization. The only structural
gap is the single-value `(scope, resource)` key, solved with a separate policy
layer rather than by overloading P9 rows.

---

## 8. UI Visibility

Recommended classification based on the existing information architecture
(`apps/web/src/views/Usage.tsx`, `apps/web/src/views/admin/AdminUsage.tsx`).

| Resource | Visibility | Rationale |
|---|---|---|
| AI generation (tokens) | **VISIBLE** | primary cost; users expect it |
| AI embeddings | **PARTIALLY_VISIBLE** | summarize under "Knowledge" |
| AI image | **VISIBLE** | countable generations |
| DataForSEO keyword/SERP | **VISIBLE** | primary cost dimension |
| Jina fetch | **INTERNAL** | infrastructure detail |
| Cohere rerank | **INTERNAL** | infrastructure detail |
| Qdrant | **INTERNAL** | infrastructure detail |
| GSC / GA4 / Ads reads | **PARTIALLY_VISIBLE** | show volume, not cost (user-funded) |
| Publishing attempts | **PARTIALLY_VISIBLE** | operational, not cost |
| Jobs / queue | **PARTIALLY_VISIBLE** | show depth/status, not as a billable meter |
| API requests | **INTERNAL** | abuse surface |
| Storage | **UNKNOWN - product decision** | depends on eventual model |

Where it fits: the existing `Usage` view already serves both project and account
scope through one `UsageReportDto` (`apps/api/src/http/routes/usage.ts:64-97`).
Resource visibility should extend this view rather than add a new system. Note
that today no view surfaces `seo_resource_denials`; denial visibility is a
candidate (section 13, P2).

---

## 9. Monetization Candidates

No prices are proposed. "Suggested model" is structural only.

| Resource | Monetizable? | Suggested model | Confidence |
|---|---|---|---|
| DataForSEO | Yes | monthly allowance / credits | High |
| AI generation | Yes | monthly allowance (tokens or runs) | High |
| AI embeddings | Yes | bundled into knowledge/AI allowance | High |
| AI image | Yes | credit per generation | High |
| Storage | Maybe | included quota + overage | Low (cost UNKNOWN) |
| Media search (Unsplash) | Maybe | bundled with AI/media | Medium |
| Publishing attempts | Maybe | per connected site / attempt | Medium (user-funded) |
| Jina fetch | No | internal, bundled | High |
| Cohere rerank | No | internal, bundled | High |
| Qdrant | No | infra, bundled into embeddings | High |
| Google API reads | **No** | user-funded; monitor only | High |
| Job queue / concurrency | No | technical; optional "priority" much later | Medium |
| Projects / members / API keys | **UNKNOWN - product decision** | seat/project tiers possible | Low |
| HTTP API requests | No | technical; per-key limits are abuse control | High |

**Suitable for monthly allowance:** DataForSEO, AI generation, AI image,
embeddings.
**Suitable for concurrency limits:** AI generation, DataForSEO (already partly
via P9), knowledge indexing.
**Suitable for per-project limits:** DataForSEO, AI, embeddings.
**Suitable for overage / pay-as-you-go:** DataForSEO and AI are the natural
candidates once cost derivation exists.
**Must never be monetized:** Google API reads (the user's quota funds them),
WordPress/X publishing (user credentials), and the core queue/rate protections.

---

## 10. Abuse / Attack Surface

P9 admission is uniform for **enqueued** work. The gaps are work that never
creates a `seo_sync_jobs` row, plus surfaces outside the class rate limiters.

| Surface | Risk | Evidence |
|---|---|---|
| Synchronous LLM in routes: `POST content/:id/ai`, `/ai/edit`, `GET content/:id/intelligence?with_ai=1` | **High** - not P9-admitted; the GET bypasses the `expensive` tier (which counts only mutating methods) and is available to **viewers** | `content.ts:204-241,282-295`, `rateLimitClasses.ts:29,62` |
| Synchronous Composer/Designer/Writer planner + research | **High** - not P9-admitted; only the process-local `expensive` tier | `composition.ts:59-80`, `designer.ts:195-250`, `writer.ts:84-108,223-278` |
| Writer in-process background resumes (`approval`/`revise`/`magic`/`agent`) | **Medium** - `void` resume, no durable job, no P9 | `writerRunService.ts` (`resume*InBackground`) |
| Generic `POST /jobs` param bypass (`days`, keyword seeds) | **Medium** - route-only validators, generic path skips them; executor does not re-clamp | `jobs.ts:27-55`, `executors.ts:153,361-420` |
| `/api/v1` and `/api/mcp` API-key traffic | **Medium** - no class limiter; IP-only keying | `app.ts:229,234`, `v1.ts:170-186`, `mcp/server.ts:313-358` |
| `/performance/sync`, `/integrations/:id/test`, `/publishers/:id/test` | **Low/Medium** - no class limiter; sync provider calls | `projectPerformance.ts:48-61`, `integrations.ts:170-195`, `publishers.ts:173-194` |
| OAuth callbacks (unauthenticated) | **Low** - strict limiter; token exchange only | `oauth.ts:97-176` |
| Schedules / retries / cancellation | Covered by P9; retry is an UPDATE, so no reservation multiplication | `resource_protection.sql:22-25`, `scheduleService.ts:195` |
| Admin paths / internal jobs | Covered by P9 (all inserts) | `guardedJobStore.ts:34-50` |

**Conclusion:** no path *bypasses* P9 for enqueued work. The real gap is the
class of **synchronous expensive operations**, which P9 was never scoped to
cover. This is a protection gap, not a P9 regression.

---

## 11. Canonical Resource Taxonomy

Codebase-derived (six usage categories + infrastructure; provider names from the
registry):

```text
RESOURCE
├── External API
│   ├── Google
│   │   ├── Search Console   (user-funded)
│   │   ├── Analytics GA4    (user-funded)
│   │   └── Ads              (user-funded)
│   └── DataForSEO           (BYOK / env fallback)
│
├── AI  (BYOK / env fallback)
│   ├── generation (chat/writer/agent)
│   ├── embeddings (env-only)
│   └── image (BYOK / env fallback)
│
├── Research
│   ├── keyword research / expansion  (DataForSEO)
│   ├── SERP                          (DataForSEO)
│   └── competitor / domain research  (DataForSEO)
│
├── Knowledge infrastructure
│   ├── Jina fetch     (env-only)
│   ├── Cohere rerank  (env-only)
│   └── Qdrant vectors (infra)
│
├── Content
│   ├── generation / rewriting (AI)
│   └── media (Unsplash env-only, OpenAI image)
│
├── Publishing  (user-owned)
│   ├── WordPress
│   └── X / social
│
└── Infrastructure
    ├── jobs / queue / concurrency   (P9)
    ├── HTTP API / rate limits
    └── storage / uploads
```

Provider tokens align with `PROVIDER_IDS`
(`apps/api/src/providers/registry.ts`) and usage `provider` values (`openai`,
`dataforseo`, `gsc`, `ga4`, `ads`, `wordpress`, `unsplash`, ...).

---

## 12. Recommended Architecture

Target separation (no implementation in P10):

```text
                    Resource
                       |
            ┌──────────┴──────────┐
            |                     |
     Technical Policy       Product Policy
     (infrastructure,       (entitlement /
      abuse, concurrency)    subscription)
            |                     |
            └──────────┬──────────┘
                       |
             Effective limit resolver
                       |
                   Admission  (atomic, P9)
                       |
                     Usage  (ledger, post-hoc)
```

Responsibility placement:

| Responsibility | Where it belongs | Today |
|---|---|---|
| Technical ceiling data | Database (`seo_resource_limits`) | exists (P9) |
| Product/entitlement data | Database (new per-account policy/entitlement table) | does not exist |
| Effective-limit resolution | Admission helper / entitlement service | partial (single default) |
| Atomic enforcement | Database trigger + advisory locks | exists (P9) |
| Pre-request decision for **sync** work | A synchronous admission service, or route the work through the queue | **missing** |
| Usage facts | Append-only ledger (`seo_usage_events`) | exists |
| Funding attribution (BYOK vs operator) | Usage metadata / new column + admission denial | **missing** |
| Subscription/account state | Account domain service | does not exist |
| UI | Reads usage + entitlements; never enforces | usage only |

Design rule: **technical policy is a floor that always applies; product policy
can only lower it.** Admission evaluates `min(technical_ceiling,
product_entitlement)` so a plan can never exceed infrastructure safety.

---

## 13. Debt / Blockers

| Priority | Item | Why | Evidence |
|---|---|---|---|
| **P0** | Synchronous expensive operations are not admitted (content AI, Composer, Designer, Writer planner/research, `?with_ai=1`) | unbounded LLM/provider cost outside P9; `?with_ai=1` is viewer-accessible and GET-tier-exempt | section 10 |
| **P0** | Server-funded env fallback + open unverified signup | operator can be billed with no further user action | `aiService.ts:169-172`, `embedding.ts:111-136`, `config.ts:56-118` |
| **P1** | No funding attribution (BYOK vs operator) on usage/denial facts | cannot tell who paid for a unit | `usageEvent.ts:109-129` has no funding field |
| **P1** | P9 enforces queue depth/rate, not per-resource ceilings | a single project could still drain a provider allowance within queue caps | `resource_protection.sql:118-190` |
| **P1** | Generic `/jobs` param bypass (`days`, seeds) | route-only caps not enforced at execution | `jobs.ts:27-55`, `executors.ts:153,361-420` |
| **P1** | `/api/v1`, `/api/mcp`, `/performance`, `/integrations`, `/publishers` lack class limiter | abuse surface | `app.ts:175-234` |
| **P2** | Jina, Cohere, Qdrant, storage unmetered | economics blind spots | section 6.3 |
| **P2** | No denial visibility (`seo_resource_denials` has no UI) | operators cannot see abuse attempts | `20260101000039_resource_protection.sql:209-235` |
| **P2** | `seo_resource_limits` is global per scope, not per account/project | cannot express a per-account plan | `:38-65` |
| **P3** | No cost derivation (`usage -> pricing -> cost`) | needed only once pricing is decided | `usageEvent.ts:20-22` |
| **P3** | Process-local rate limiter not distributed | multiplies under horizontal scale | `http/rateLimit.ts` |

No blocker is a **P9 regression**; P9's scope was the job queue, and it meets it.

---

## 14. P11 Recommendation

**Canonical taxonomy:** section 11 (External API / AI / Research / Knowledge
infra / Content / Publishing / Infrastructure), aligned to the six usage
categories.

**Economically most important resources (top 5, in order):** AI text
generation, DataForSEO, embeddings, AI image, Jina + Qdrant (knowledge infra).
These are the resources the operator actually pays for.

**Technical protections still missing:** admission for synchronous expensive
work; per-key/per-account limits on `/api/v1` and `/api/mcp`; server-side
re-validation of generic `/jobs` params; distributed rate limiting; index-size
protection for Qdrant.

**Good future monetization dimensions:** DataForSEO, AI generation, embeddings,
AI image (allowances); storage (product decision). **Never monetize:** Google
API reads, WordPress/X publishing, and the core queue/rate protections.

**Reusable existing infrastructure:** `seo_usage_events` + `usageEvent`
vocabulary, the `UsageReportDto` read path, `AIService` key resolution
(account→project→env), the DataForSEO BYOK chain, and the P9 admission layer.

**Architecture changes required before monetization:** (1) funding attribution
on facts, (2) a per-account policy/entitlement table with an effective-limit
resolver over P9's technical ceilings, (3) admission coverage for synchronous
work, (4) close the validation/limiter gaps.

### Recommended P11

Because P0/P1 protection gaps exist and monetization is explicitly postponed,
the recommended P11 is **protection-completion, still without
pricing/billing/subscriptions**:

1. **Admission coverage for synchronous expensive work** - either enqueue it or
   give it a synchronous admission check with the same atomic guarantees.
2. **Per-resource technical ceilings** - extend admission beyond queue
   depth/rate to the `ResourceKind` vocabulary, keeping `seo_resource_limits`
   as the technical floor.
3. **Funding attribution** - record BYOK vs operator (env) and the provider on
   usage facts and denials so cost ownership is knowable.
4. **Close the known gaps** - `/jobs` param re-validation, class limiters on
   `/api/v1`, `/api/mcp`, `/performance`, `/integrations`, `/publishers`.

Only after P11 should a **P12 entitlement/plan layer** be considered; that layer
should be data-driven (per-account policy resolved over P9's technical floor) so
plans change without touching admission logic. Pricing, Stripe and invoices
remain out of scope until the product explicitly chooses a model.

---

## 15. Acceptance Criteria Check

- [x] All major resource-consuming flows investigated (section 2, 10).
- [x] Google GSC/GA4/Ads assessed separately (sections 2-4, 9).
- [x] DataForSEO assessed separately (sections 2-3, 9).
- [x] AI/provider consumption investigated (sections 2-3, 6).
- [x] Qdrant/embeddings investigated (sections 2-3, 6).
- [x] Keyword/competitor research investigated (sections 2-3).
- [x] Publishing/media investigated (sections 2-4).
- [x] Jobs/schedules/MCP/API v1 investigated (sections 2, 10).
- [x] Existing `seo_usage_events`/provider metering reconciled (section 6).
- [x] Technical limits separated from product limits (section 5).
- [x] Scope per resource established or marked UNKNOWN (section 4).
- [x] P9 compatibility explicitly assessed (section 7 A-F).
- [x] Monetization assessed without redesigning P9 (sections 7, 12, 14).
- [x] UI-visible vs internal resources distinguished (section 8).
- [x] Abuse/alternate entry points investigated (section 10).
- [x] Concrete P0-P3 debt/blockers named (section 13).
- [x] P11 recommendation given (section 14).
- [x] **No product or code implementation performed.**

## 16. Constraints Honoured

No migrations, schema changes, API changes, UI changes, subscription logic,
Stripe, pricing, tiers, entitlement enforcement or new resource limits were
added. No product code was changed. Monetary amounts are **External
pricing/configuration required**; no cost was fabricated. Items the codebase
cannot answer are marked **UNKNOWN - requires product decision**.
