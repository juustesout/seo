# P11 - Resource Protection Completion

P11 makes resource protection **technically complete across the whole product**.
It builds directly on the P9 foundation (async job admission) and the P10 recon
(`docs/p10-resource-economics-monetization-recon.md`).

P11 is **technical protection only**. It introduces no plans, subscriptions,
prices, entitlements, Stripe, invoices, balances or feature tiers. A future
entitlement layer (P12) resolves *on top of* the technical floors described here.

## 1. What P10 found, and what P11 closes

P10 concluded that P9 protects async work at the queue but that expensive
server-funded consumption also happens **synchronously, inside an HTTP request,
without a job row**. P11 adds a second, *generic* admission primitive for that
class of work and threads funding attribution through the usage ledger.

| P10 finding | P11 resolution |
| --- | --- |
| Composer/Designer/Writer/content-AI/`?with_ai=1` run outside P9 | Admitted through `seo_admit_resource` via one service seam |
| `?with_ai=1` reachable from a viewer | AI pass now requires `editor`; deterministic report stays `viewer` |
| `/jobs` accepts params the feature routes cap (`days`, seeds) | Executor re-clamps `days`/seeds at the workload boundary |
| `/api/v1`, MCP, schedules, worker, retries | Confirmed to flow through the P9 trigger; no gap remains |
| `/integrations`, `/publishers`, `/performance` | Async paths go through P9; `/test`/sync bound by class rate limits |
| Usage ledger cannot tell BYOK from operator-funded | `seo_usage_events.funding_source` (`byok` / `operator_funded` / null) |
| Open signup + server-funded keys | Bounded by the same technical ceilings as every other account |

## 2. Resource protection model

```text
Technical Resource Protection
            |
            v
     Admission / Ceiling          <- "may this operation start?"
            |
            v
      Resource Usage              <- "what was actually consumed?" (ledger)
```

Admission and usage are deliberately **separate**:

* **Admission** evaluates a conservative technical ceiling and records a
  reservation. A denial is *not* usage and never inflates consumption.
* **Usage** is an append-only fact in `seo_usage_events`. It records what was
  really consumed, by whom, under which funding source.

One consistent model serves both async and sync work:

* async work -> `seo_admit_job()` BEFORE INSERT trigger on `seo_sync_jobs` (P9);
* sync work -> `seo_admit_resource()` called through the single
  `ResourceAdmissionService.withAdmission()` seam (P11).

Both raise the same structured SQLSTATEs (`SE001` queue, `SE002` concurrency,
`SE003` rate), map to the same 429 `{ code, message, details }` API error and
share the same resource vocabulary (`packages/contracts/src/resourceProtection.ts`).

## 3. Synchronous resources now protected

All synchronous server-funded operations are admitted through
`ResourceAdmissionService.withAdmission({ projectId, userId, resource })`, which
reserves an in-flight slot, runs the work and releases it in a `finally`.

| Entry point | Resource | Provider | Funding | Scope | Field |
| --- | --- | --- | --- | --- | --- |
| `POST /content/:id/ai` (`ContentAiService.run`) | `ai_generation` | OpenAI | BYOK / operator | project + account | `withAdmission` |
| `POST /content/:id/ai/edit` (`ContentAiEditService.run`) | `ai_generation` | OpenAI | BYOK / operator | project + account | `withAdmission` |
| `GET /content/:id/intelligence?with_ai=1` (`ContentIntelligenceService`) | `ai_generation` | OpenAI | BYOK / operator | project + account | `withAdmission` (AI pass only) |
| `POST /composition/plan` (`CompositionPlannerService.plan`) | `ai_generation` | OpenAI | BYOK / operator | project + account | `withAdmission` |
| `POST /composition/compose` (`CompositionService.compose`) | `ai_generation` | OpenAI | BYOK / operator | project + account | `withAdmission` |
| `POST /designer/runs` plan + intent (`DesignerService`) | `ai_generation` | OpenAI | BYOK / operator | project + account | `withAdmission` |
| Writer run/planner/research/intelligence + in-process resumes (`WriterRunService`) | `ai_generation` | OpenAI | BYOK / operator | project + account | `withAdmission` |

Notes:

* One logical operation = **one** reservation. Composer and Designer call their
  internal `planAdmitted` / `executeAdmitted` variants for sub-steps so a nested
  plan never double-reserves.
* Embeddings, Cohere, Jina and Unsplash are always server-funded; they are
  protected by the usage/funding ledger and by the `expensive` class rate
  limiter, and knowable through the same resource vocabulary.
* Google GSC/GA4 reads and WordPress/X publishing use **user-owned credentials**;
  they flow through P9 job admission and are not priced as operator resources.

## 4. Async protection completion

P9 already enforces admission at the table, so **no enqueue path can bypass it**.
P11 verified every entry point named in P10:

| Path | How it is admitted |
| --- | --- |
| `POST /api/projects/:id/jobs` | `seo_sync_jobs` INSERT -> `seo_admit_job` |
| `/api/v1` analyze enqueue | same table -> trigger |
| MCP `content_*`, `designer_execute` | enqueue / durable agent run -> trigger |
| Schedules (`ScheduleService`) | `jobStore.enqueue` -> trigger |
| Worker-generated jobs | same table -> trigger |
| Retry | UPDATE back to `queued` on the same row; never a second reservation |
| Cancellation / completion / failure | status change releases the queued/running slot |
| Feature routes (GSC, GA4, DataForSEO, knowledge, publishing) | shared `enqueueJob` -> trigger |

`/performance/sync` enqueues GSC and GA4 sync jobs, so it is admitted by the P9
trigger as well.

## 5. Technical ceilings

Ceilings live in `seo_resource_limits` as **data** (adjustable without a
redeploy) with in-code fallbacks so a missing row can never silently disable
protection. They are operational safety bounds, not commercial quotas.

P9 (async jobs), unchanged:

| scope | resource | value | window |
| --- | --- | --- | --- |
| project | `jobs_queued` | 25 | - |
| account | `jobs_queued` | 100 | - |
| project | `jobs_running` | 10 | - |
| account | `jobs_running` | 40 | - |
| project | `jobs_create_rate` | 60 | 60s |
| account | `jobs_create_rate` | 180 | 60s |

P11 (synchronous work), new:

| scope | resource | value | meaning |
| --- | --- | --- | --- |
| project / account | `sync_create_rate` | 60 / 180 per 60s | admitted sync operations per window |
| project / account | `ai_generation_inflight` | 6 / 20 | concurrent AI text ops |
| project / account | `ai_image_inflight` | 3 / 10 | concurrent AI image ops |
| project / account | `ai_embedding_inflight` | 4 / 15 | concurrent embedding ops |
| project / account | `dataforseo_inflight` | 4 / 12 | concurrent DataForSEO ops |
| project / account | `media_inflight` | 4 / 12 | concurrent media provider ops |

The `*_inflight` ceiling is evaluated with a floor fallback of 4 (project) /
12 (account) when a specific row is absent.

## 6. Resource scope

Every ceiling is evaluated at **two scopes at once**: the project and the
project's account.

* **project** - bounds a single project, so one runaway project cannot starve
  the rest of an account.
* **account** - bounds the account, so a user cannot multiply a resource by
  creating more projects.

Ordering is always **account first, then project** (the same order P9 uses), so
two concurrent writers can never deadlock. A project ceiling can never be
dodged by using a sibling project, because the account ceiling still applies.

## 7. Funding attribution

`seo_usage_events` gains a nullable `funding_source` column with a check
constraint:

* `byok` - the call was funded by a **user-supplied** credential (account- or
  project-scoped key);
* `operator_funded` - the call was funded by a **server environment** key;
* `null` - not attributable (e.g. a mixed background job, or an unconfigured
  resolver that emits nothing).

Derivation is centralized where the credential is resolved:

* AI text/image: `account`/`project` key -> `byok`; `env` -> `operator_funded`;
  no key -> null (`ads/api/src/services/aiService.ts`).
* Embeddings: funding follows the embedding credential resolution.
* Publishing: provider context is explicitly `byok` (user credentials).
* Provider request emitters (GSC, GA4, Ads, DataForSEO, media, publishing,
  knowledge) copy `fundingSource` from their usage scope onto each event.

A usage event can therefore answer: **who, what resource, how much, when,
which project/account, who funded it** - with no billing logic.

## 8. `?with_ai=1` and the viewer gap

`GET /content/:id/intelligence?with_ai=1` previously ran a server-funded AI pass
and was reachable with viewer rights.

* Route: `apps/api/src/http/routes/content.ts`.
* Required authorization: the deterministic report stays `viewer`; when
  `with_ai` is requested the route requires `editor`.
* Resource consumed: `ai_generation` (OpenAI), admitted through the service.
* Credential: account -> project -> server env, attributed as above.
* Usage recorded: yes, on the instrumented provider.
* Protection: editor gate + `ai_generation` reservation.

The parameter is retained (the flow is legitimate for editors); only the
protection gap is closed.

## 9. API / MCP / integration / publisher / performance coverage

| Surface | Expensive resource? | Protection |
| --- | --- | --- |
| `/api/v1` | enqueues analysis (async) | P9 trigger + `moderate` class limiter |
| `/api/mcp` | enqueues jobs / designer runs | P9 trigger + `expensive` class limiter |
| `/performance` (`/sync`) | enqueues GSC/GA4 sync | P9 trigger + `moderate` class limiter |
| `/integrations/:id/test` | user/provider probe | `expensive` class limiter |
| `/publishers/:id/test` | user/provider probe | `expensive` class limiter |

Protection is enforced **server-side**; the web UI is never the boundary.

## 10. `/jobs` parameter / bypass closure

The generic `POST /jobs` route accepts arbitrary `params`, while feature routes
validate them. P10 showed the executor did not re-clamp, so a caller could ask a
`gsc_sync` for an arbitrarily large date range or a keyword-research job for an
unbounded seed list.

P11 closes this **at the workload boundary** (`apps/api/src/jobs/executors.ts`),
so it holds regardless of enqueue path:

* `gsc_sync`: `days`/`rangeDays` clamped to 1..90; a malformed `endDate` falls
  back to today; an explicit `startDate` that would widen the range past the
  ceiling is ignored.
* `dataforseo_keyword_research`: the seed list is trimmed to at most 5 valid
  seeds of at most 200 characters.

No general `/jobs` rewrite was performed: only the concrete, proven bypasses
were fixed.

## 11. Open signup + server-funded keys

Every authenticated user already receives the full product. Server-funded
consumption by a brand-new account is bounded technically by:

* `jobs_*` ceilings (P9) on background work;
* `sync_create_rate` + `*_inflight` ceilings (P11) on synchronous work;
* per-account and per-project scopes, so new projects cannot multiply a resource;
* the `expensive`/`moderate` class rate limiters.

No paid-only feature, subscription gate, verification or paywall was introduced.
If a future decision requires limiting free accounts below the technical floor,
that is a **PRODUCT DECISION REQUIRED** and belongs to P12 (entitlement), not to
the admission layer.

## 12. Usage events

Existing `seo_usage_events` is reused; the only schema change is the
`funding_source` column. Resource vocabulary, provider, project/account and
success/failure semantics are unchanged. Admission state and usage facts remain
distinct: a denial is recorded (best-effort) in `seo_resource_denials`, never as
usage. Retries do not duplicate reservations (UPDATE, not INSERT). Emission
failure can never break the underlying operation.

## 13. Failure semantics

Sync admission returns the same structured error as P9 async admission:

* HTTP **429** with `{ error: { code, message, details } }`;
* `code` in `resource_limit` / `resource_concurrency` / `queue_limit`;
* `details` = `{ resource, scope }` - never counts, limits, credentials or
  provider internals.

An unrecognised database error becomes a generic `500 resource_admission_failed`
rather than a false denial.

## 14. Concurrency / race conditions

Ceilings are evaluated **atomically inside the database**, under
transaction-scoped advisory locks taken in a fixed order (account, then
project). Two simultaneous requests for the last available slot cannot both
succeed: the second either sees the first's reservation or waits for the lock.
There is no read-then-write race in application code. This is proven end-to-end
by the fresh-database smoke test (`scripts/db-migrate-local.sh`, P11 section).

## 15. Provider-specific protection

Server-funded providers are the ones whose credentials can come from the server:
OpenAI text/image, embeddings, DataForSEO, Jina, Cohere and Qdrant. These are
covered by the resource vocabulary, the sync ceilings and the usage/funding
ledger. Google reads (GSC/GA4/Ads) and user-funded WordPress/X publishing are
**not** treated as monetization resources; they remain bounded by P9 job
admission and technical provider/rate limits where they exist.

## 16. P9 compatibility

* `seo_admit_job()` stays the **only** admission primitive for background work.
* `seo_admit_resource()` is the new primitive for synchronous work; both share
  the resource vocabulary, the SQLSTATE contract and the API error shape.
* Technical ceilings live in one table (`seo_resource_limits`) for both.
* Funding attribution lives on the usage ledger, not on the admission primitive.
* `seo_resource_limits` is **not** a subscription policy engine and
  `seo_admit_job` is **not** plan-aware.

## 17. Tests

* `ResourceAdmissionService` unit tests: classification, denial recognition,
  error mapping, reservation lifecycle, release best-effort, denial evidence.
* Sync service tests: every admitted service passes through the real admission
  code path (`admittingResourceAdmission`); a denial surfaces as a 429
  (`denyingResourceAdmission`).
* Funding: `operator_funded` for env keys, `byok` for user keys, null when the
  scope sets none.
* Bypass regression: oversized `gsc_sync` `days` / `startDate` and an oversized
  keyword seed list are clamped.
* Access: a viewer cannot trigger the server-funded `?with_ai=1` pass; an editor
  can.
* Integration: the P11 migration smoke asserts the rate/in-flight ceilings, that
  release frees a slot and that the account scope cannot be dodged by a sibling
  project.
* Regression: the full P9 suite stays green.

## 18. UI

No new usage/quota UI was added. The existing resource-error rendering continues
to work for the sync 429, because it shares P9's error shape. No quota
dashboards, progress bars, plan badges, upgrade buttons or pricing UI.

## 19. Future entitlement layer (P12)

A future entitlement layer resolves **on top of** these technical floors:

* it may **lower** an account's effective ceiling (plan limit); it can never
  raise the technical floor;
* it reads the same resource vocabulary, ceilings table and usage/funding ledger;
* admission stays oblivious to plans - entitlement is evaluated before calling
  the admission seam.

Pricing, invoices, balances and payment logic are explicitly out of scope here.

## 20. Migration / architecture debt

* **P2 follow-up** - rate limiting is process-local in-memory; a multi-instance
  deployment should move it to a shared store. This does not affect the atomic
  DB admission guarantees.
* **P2 follow-up** - a background sweeper could prune expired
  `seo_resource_reservations` rows; TTL expiry already makes them inert.
* **PRODUCT DECISION REQUIRED** - whether new accounts get a lower *product*
  entitlement than established ones. This is a policy choice, not a technical
  floor, and must not be implemented inside admission.
* **P12 ENTITLEMENT** - plans, subscriptions, quotas-as-entitlements, billing.

## 21. Files and migrations changed

* `packages/contracts/src/usageEvent.ts` - `FundingSource`, `fundingSource`,
  `isValidFundingSource`.
* `packages/contracts/src/providers.ts` - `ProviderUsageContext.fundingSource`.
* `supabase/migrations/20260101000040_sync_resource_protection.sql` - funding
  column, `seo_resource_reservations`, `seo_admit_resource`,
  `seo_release_resource`, sync ceilings.
* `apps/api/src/services/resourceAdmission.ts` (+test), test support doubles.
* Sync admission wiring: `contentAiService`, `contentAiEditService`,
  `contentIntelligenceService`, `compositionPlannerService`,
  `compositionService`, `designerService`, `writerRunService`.
* Funding: `aiService`, `usageInstrumentation`, `usageEventRepository`,
  provider usage emitters (`gsc`, `ga4`, `googleAds`, `dataforseo`, `media`,
  `publishing`, `knowledge`).
* `apps/api/src/jobs/executors.ts` - workload-boundary param clamps.
* `apps/api/src/http/routes/content.ts` - `?with_ai=1` editor gate.
* `apps/api/src/http/rateLimitClasses.ts` - class coverage.
* `scripts/db-migrate-local.sh` - P11 smoke.

## 22. Final report

1. **P10 P0/P1 gaps resolved**: viewer-triggered `?with_ai=1`, synchronous
   expensive operations outside P9, generic `/jobs` param bypass, missing
   funding attribution, uniform coverage of API v1 / MCP / schedules /
   performance / integrations / publishers.
2. **Ceilings added**: `sync_create_rate` and `*_inflight` for
   `ai_generation`, `ai_image`, `ai_embedding`, `dataforseo`, `media`, at
   project and account scope.
3. **Synchronous resources now protected**: content AI / AI edit /
   `?with_ai=1`, Composer plan+compose, Designer plan+intent, Writer
   planner/research/intelligence and in-process resumes.
4. **Entry points covered**: HTTP (web + `/api/v1`), MCP, schedules, worker,
   retries, publishing, integrations/publishers test endpoints, generic `/jobs`.
5. **Funding attribution**: `byok` / `operator_funded` / null on
   `seo_usage_events.funding_source`, derived from the resolving credential.
6. **P10 findings no longer applicable**: no path bypasses P9 for enqueued work;
   the executor now re-clamps; the viewer AI gap is closed.
7. **Remaining gaps**: process-local rate limiting; reservation pruning (both
   P2, non-blocking).
8. **P12**: plans, subscriptions, entitlements, billing.
9. **Files/migrations**: see section 21; migrations count is now 40.
10. **Verification**: lint, typecheck, tests, build, fresh-DB migration smoke
    and `git diff --check`, all green.
