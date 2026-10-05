# P9 - Resource Protection Foundation

> **P9 does not implement monetization.**
>
> **P9 does not introduce feature tiers.**
>
> Every authenticated user still gets the full product. P9 adds server-side
> resource *protection*: it makes expensive and potentially abusive operations
> **bounded and attributable**. It introduces no billing, subscriptions, plans,
> credits, prices, paywalls or paid/free feature distinctions.

Baseline: `docs/resource-protection-monetization-recon.md` (the reconnaissance
this phase implements). This document describes what P9 actually builds.

---

## 1. Protected resources

Admission reasons about a small, closed resource vocabulary
(`@seo/contracts/resourceProtection`):

```text
ai_generation, ai_embedding, ai_image
dataforseo_research, dataforseo_serp, dataforseo_keywords
google_search_console, google_analytics, google_ads
background_job, publishing, media
```

The vocabulary mirrors the usage-event categories/units at the granularity
admission needs, so a denial and the eventual usage event can be reasoned about
together. Each platform job type is classified onto one resource
(`apps/api/src/services/resourceAdmission.ts`), e.g.:

| job type | resource |
| --- | --- |
| `content_generate`, `content_write`, `content_analyze`, `agent_design` | `ai_generation` |
| `content_images` | `ai_image` |
| `gsc_sync` | `google_search_console` |
| `analytics_sync` | `google_analytics` |
| `dataforseo_keyword_research` | `dataforseo_keywords` |
| `dataforseo_rank_sync`, `serp_retrieval` | `dataforseo_serp` |
| `competitor_research` | `dataforseo_research` |
| `publish`, `publish_update`, `publish_delete` | `publishing` |
| `knowledge_*`, `website_*`, unknown | `background_job` |

Unknown/future job types fall back to `background_job`, so a newly added type is
still admitted and attributed rather than silently exempt.

---

## 2. Admission architecture

```text
authenticated request / MCP call / schedule / worker reconcile
        |
        v
container.jobStore.enqueue(...)            <- the single enqueue seam
        |
        v
GuardedJobStore.enqueue                    <- app half: map denial, record evidence
        |
        v
PostgresJobStore / SupabaseJobStore insert
        |
        v
seo_sync_jobs BEFORE INSERT trigger seo_admit_job   <- atomic authority
        |
   allow |  deny (SQLSTATE SE001/SE002/SE003)
        |
        v
job row (the reservation)  |  structured resource error + seo_resource_denials row
```

Two layers, one decision:

- **Database trigger** (`seo_admit_job`) is the authority. It runs inside the
  inserting transaction for *every* insert into `seo_sync_jobs`, so no caller
  can opt out and concurrent transactions cannot oversubscribe. It takes
  transaction-scoped advisory locks (account first, then project) before
  counting, then raises `SE001`/`SE002`/`SE003`.
- **`GuardedJobStore`** wraps whichever store the container selected and is the
  only enqueue seam in the app. It recognises the denial, records denial
  evidence, and throws a stable `ApiError`.

This deliberately answers one question in one obvious place: *may this account
consume this resource?*

---

## 3. Limits

Limits are **conservative operational safety ceilings, not customer plans**.
They live in the data table `seo_resource_limits` (adjustable without a
redeploy) and the trigger falls back to the same defaults if a row is missing.

| scope | resource | default | why |
| --- | --- | --- | --- |
| project | `jobs_queued` | 25 | a single project cannot build an unbounded backlog while one worker drains it |
| account | `jobs_queued` | 100 | several projects cannot each queue 25 and multiply the backlog |
| project | `jobs_running` | 10 | bounds concurrent provider work per project |
| account | `jobs_running` | 40 | bounds concurrent provider work per account across projects |
| project | `jobs_create_rate` | 60 / 60s | caps repeated/looping job creation from one project |
| account | `jobs_create_rate` | 180 / 60s | caps repeated creation spread across projects |

Numbers derive from the recon (one worker process executes one job at a time;
the queue was previously unbounded) rather than arbitrary SaaS conventions.

---

## 4. Queue protection

- Checked **before insertion**, inside the same transaction.
- Enforced **atomically**: the advisory lock serialises concurrent inserts for
  the same scope, so `current + requested <= ceiling` is evaluated correctly
  even under a race.
- Counts **queued and running** work separately, per project and per account.
- Not process-local; a multi-process API or a scaled worker fleet shares the
  same database ceiling.
- On breach: a structured error the UI can explain (section 10).

---

## 5. Reservation lifecycle

The job row **is** the reservation:

| transition | effect |
| --- | --- |
| insert (`queued`) | consumes capacity |
| `claimNext` -> `running` | still consumes capacity |
| `complete` / terminal `fail` / `cancel` | releases capacity |
| retryable `fail` -> `queued` | stays consumed; it is the same row (no new insert) |

The trigger runs **only on INSERT**, so:

- retries never multiply reservations (an UPDATE is not an INSERT) - one
  logical job is at most one reservation;
- terminal failure and cancellation release capacity (no leak);
- a successful job cannot release twice (its terminal transition is the single
  release).

Stale running jobs still go through the worker's existing sweep
(`sweepStaleRunning`), which requeues or terminally fails them, releasing
capacity in the terminal case.

---

## 6. API / MCP coverage

All enqueue paths insert through `container.jobStore`, which is
`GuardedJobStore`. Audited call sites (17):

- generic jobs route - `apps/api/src/jobs/enqueue.ts` (also used by keyword
  research and other feature routes)
- `content_generate`, `content_images`, `content_analyze` -
  `apps/api/src/http/routes/content.ts`
- writer draft - `apps/api/src/services/contentDraftService.ts`
- opportunity -> content write - `apps/api/src/http/routes/opportunities.ts`
- versioned API - `apps/api/src/http/routes/v1.ts` (content analyze)
- MCP `content_generate`, `content_resolve_images` -
  `apps/api/src/mcp/server.ts` (deps carry `container.jobStore`)
- publish operations - `apps/api/src/services/publicationJobs.ts`
- knowledge discovery / ingest / refresh / delete -
  `apps/api/src/services/knowledgeService.ts`
- designer run + orphan reconciliation - `apps/api/src/services/agentRunService.ts`
- scheduled publishing - `apps/api/src/services/scheduleService.ts`

`/api/v1` and `/api/mcp` therefore share exactly the same admission policy as
the web UI: there is no separate MCP quota logic.

---

## 7. Scheduled / background behavior

Scheduled publishing and worker-driven reconciliation enqueue through the same
`container.jobStore`, so they are admitted identically. A scheduled job is a
normal `queued` row (with a future `run_after`) and counts against the
project/account ceilings. There is deliberately **no trusted-background bypass**:
background execution is still resource consumption.

---

## 8. Usage relationship

`seo_usage_events` is unchanged and remains the historical measurement layer.

```text
admission  -> reservation -> operation -> usage event
```

Admission decides what is *allowed*; usage events record what *actually
happened*. They are separate concerns. P9 does not replace, backfill or rewrite
the ledger, and a denial is **not** written as usage (see section 11).

---

## 9. BYOK behavior

BYOK semantics are unchanged. P9 does not make BYOK users unlimited and does not
reclassify credentials. The admission layer bounds **jobs and queue depth**, not
per-request token spend; it therefore applies equally to AI text/image jobs
whether the underlying key is the user's (BYOK) or the server's. Where the
architecture already distinguishes user-funded from server-funded resources, a
future phase can use the resource vocabulary to apply different ceilings without
changing this layer.

---

## 10. Structured errors

Stable wire shape (`{ error: { code, message, details } }`), HTTP **429**:

| code | meaning |
| --- | --- |
| `queue_limit` | too much work already queued for the scope |
| `resource_concurrency` | too much work already running for the scope |
| `resource_limit` | too much equivalent work requested in a window |

`details` carries only `{ resource, scope }`. Responses never leak credentials,
infrastructure, other users' usage, account identifiers or queue internals.

---

## 11. Observability

Denials are recorded in `seo_resource_denials` (best-effort, written by the API
after the failed insert, since the trigger's exception rolls the transaction
back): project, account, user, resource, code, scope, requested amount, job type
and timestamp. No secrets, and a denial is never billable usage.

Both `seo_resource_limits` and `seo_resource_denials` are RLS-enabled with **no
policies** (deny-all to browser/PostgREST), reachable only by the service role /
SECURITY DEFINER functions.

Alerting/metrics are out of scope; the table is the durable operational source.

---

## 12. Known limitations

- Ceilings bound **job work** (queue depth, running concurrency, creation rate).
  Synchronous HTTP provider calls that do not enqueue (e.g. in-editor AI
  actions) remain bounded only by the existing per-process class rate limits;
  they are not yet covered by a distributed reservation.
- `run_after`-in-the-future jobs count against queue ceilings, so a large batch
  of long-scheduled work consumes capacity early (intended, but worth noting).
- Denial recording is best-effort: a logging failure does not fail the request,
  so a denial row could be missing in a rare database hiccup.
- The advisory-lock hash can, rarely, serialise two unrelated scopes; this is
  harmless (slight contention), not a correctness issue.

---

## 13. Intentionally deferred abuse controls

Not implemented (may become relevant later): behavioral bot detection, CAPTCHA,
IP reputation, device fingerprinting, ML abuse detection, trust scores,
progressive reputation, payment verification, KYC, fraud scoring.

P9 first makes the basic economic boundary real.

---

## 14. How future monetization can build on this layer

The primitives are monetization-neutral and remain useful whether the product is
free, BYOK, usage-based, subscription-based or hybrid:

- `seo_resource_limits` already expresses per-scope ceilings; a plan can seed
  different values per account without touching enforcement.
- `seo_resource_denials` and `seo_usage_events` already give attribution
  (account/project/user/resource) for a future pricing derivation.
- The resource vocabulary is shared between admission and usage, so a future
  "measured usage + pricing rule = cost" derivation can align with the same
  resources.
- Adding a paid tier would be a policy change (limits + optional entitlement
  checks), not a rewrite of the admission mechanism.

---

## Verification

- `pnpm --filter @seo/contracts build`
- `pnpm --filter @seo/api typecheck` and `pnpm --filter @seo/web typecheck`
- API unit tests: `resourceAdmission.test.ts`, `guardedJobStore.test.ts`
- Web tests: `api.test.ts` (resource messaging)
- `scripts/db-migrate-local.sh` against a fresh database, now including P9
  smoke tests: ceiling enforcement (`SE001`), running concurrency (`SE002`),
  create rate (`SE003`), release on cancel, retry does not multiply
  reservations, account-level bounding across sibling projects, deny-all RLS on
  both new tables, and a two-session race proving the queue cannot be
  oversubscribed.
