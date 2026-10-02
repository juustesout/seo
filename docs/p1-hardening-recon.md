# P1 Hardening — Recon and Design (2026-10-02)

Repository state when this phase started: `4bdc570` on `main`. This document is
the recon + design record for the four remaining P1 items from
`docs/codebase-security-audit.md`:

1. **S5** — API rate limiting
2. **S7** — HTTPS API origin
3. **Retry amplification** — shared retry budget + circuit breaker
4. **RLS isolation** — systematic testing across all `seo_*` tables

P0 remediation (S1–S4, S6, S8, S11) and the first P1 batch (error sanitization,
MCP session hardening, request ids, readiness, outbound timeouts, and a first
rate limiter) are already on `main` and are **not** redone here.

### Implementation status (2026-10-02)

| Item | Status | Where |
|---|---|---|
| S5 rate limiting (class tiers) | COMPLETE | `apps/api/src/http/rateLimitClasses.ts`, `config.ts` (`RATE_LIMIT_{STRICT,EXPENSIVE,MODERATE}_MAX`), `app.ts` mount before raw body parsers |
| S7 HTTPS API origin | INFRA ACTION REQUIRED | `vercel.json` + `apps/web/vercel.json` → `https://api.peerdisco.com/api/:path*`; Cloudflare Full (strict) live; `deploy/vps/nginx-api.conf` origin-cert 443 block + `deploy/README.md` |
| Retry policy + budget | COMPLETE | `apps/api/src/reliability/retry.ts`; worker `runWithRetryBudget`; `jobErrorPayload` uses `isRetryableError`; DataForSEO `request()` via `withRetry` |
| Circuit breaker | COMPLETE | `apps/api/src/reliability/circuitBreaker.ts`; DataForSEO client |
| Stale-running sweep | COMPLETE | `worker.ts` `sweepStaleRunning` reuses `jobStore.fail` (crash = attempt, terminal `stale_worker`) |
| RLS isolation matrix | COMPLETE | `scripts/db-migrate-local.sh` (schema-generated loop + focused write denial + platform-admin boundary) |

Verification: contracts build; `@seo/api` typecheck + 158 files / 1946 tests;
`@seo/web` typecheck + 86 files / 778 tests; `scripts/db-migrate-local.sh`
passes on a fresh database (`migration validation OK`).

---

## 1. S5 — Rate limiting

### Current state (as of `4bdc570`)

`apps/api/src/http/rateLimit.ts` implements a process-local fixed-window
limiter. It is mounted twice in `apps/api/src/app.ts`:

- a per-IP limiter before `optionalAuth` (`app.ts:126-130`), default 300/min,
  covering the unauthenticated surface (health, readiness, OAuth callback);
- a per-user (IP fallback) limiter after `optionalAuth` (`app.ts:156-161`),
  default 600/min, covering every authenticated route.

Both use the shared `{ error: { code: 'rate_limited', ... } }` envelope via
`ApiError.rateLimited` (`apiErrors.ts`) and emit `ratelimit-*` / `retry-after`
headers. Config lives in `apps/api/src/config.ts` (`RATE_LIMIT_*`), auto-disabled
under `NODE_ENV=test`.

### Gap

One blanket tier per identity means an expensive provider call (AI compose,
DataForSEO research, embeddings search, media generation, GSC/GA4 sync) shares
the same budget as a cheap content read. There are no endpoint classes.

### Deployment topology (decides storage)

`deploy/README.md` + `deploy/systemd/seo-api.service`: one API process (and one
worker process) per VPS, started by systemd, behind a single reverse proxy.
There is no horizontal scaling today and no Redis/shared cache. A process-local
limiter is therefore honest **and documented as per-instance**; no Redis is
introduced (the deployment does not need it yet).

### Design (limits derived from the endpoint inventory)

Keep the two global tiers and add three class tiers, each a distinct limiter
instance (separate buckets per class), mounted on the relevant prefixes:

| Class | Applies to (mount prefix) | Limit (per identity/window) | Rationale |
|---|---|---|---|
| OAuth / credential | `/api/oauth`, `/api/account/api-keys`, `/api/projects/:projectId/api-keys` | `RATE_LIMIT_STRICT_MAX` = 20/min | credential minting / token exchange; tiny normal volume. All methods (OAuth start/callback are GET). |
| Expensive provider | `/api/projects/:projectId/keyword`, `/composition`, `/designer`, `/content`, `/knowledge`, `/gsc`, `/analytics`, `/media` | `RATE_LIMIT_EXPENSIVE_MAX` = 30/min | each mutating call costs money/quota or heavy CPU |
| Job creation | `/api/projects/:projectId/jobs`, `/publications`, `/schedules` | `RATE_LIMIT_MODERATE_MAX` = 60/min | cheap enqueue, but not free |
| Normal reads | everything else | global authenticated tier = `RATE_LIMIT_AUTH_MAX` = 600/min | generous so normal use is never throttled |
| Health / readiness | `/api/health`, `/api/ready` | global per-IP tier only (300/min) | operational probes must not be blocked by a per-user bucket |

**Method filter (recon refinement).** A route inventory shows every expensive
prefix exposes read-only GETs alongside its mutating routes (keyword research
results, content reads, knowledge search, media list, GSC/analytics status,
design job polling, writer reads). Counting those GETs against a 30/min class
budget would throttle normal polling while a job runs, so the `expensive` and
`moderate` class limiters count **mutating methods only**
(`POST`/`PUT`/`PATCH`/`DELETE`); GET/HEAD stay on the generous global budget.
The `strict` class counts all methods because OAuth start/callback are GET.
The mount happens before the raw body parsers, so a throttled knowledge/media
upload is rejected without buffering its 12mb body.

All classes share the same fixed `RATE_LIMIT_WINDOW_MS` (60s). Class tiers only
make the global tiers tighter on hot prefixes; they never replace them. The
health/readiness endpoints intentionally stay on the IP tier so a stuck
authenticated user cannot take out monitoring.

### Response & observability

429 with `retry-after`, `ratelimit-*` headers, `code: 'rate_limited'`, plus a
structured log line (`provider`-free; identity is the user id or IP hash-free
key) emitted by the limiter. No secrets are logged.

### Tests

- unit: fixed-window enforcement, window reset, per-key isolation, Retry-After
  (`apps/api/src/http/rateLimit.test.ts`, already present);
- class behavior: separate limiter instances isolate buckets, and an express
  app mounting a strict limiter on one prefix and a generous one on another
  proves endpoint-class wiring.

---

## 2. S7 — HTTPS API origin

### Current state

Both `vercel.json` (repo root) and `apps/web/vercel.json` rewrite `/api/:path*`
to `http://144.172.102.63/api/:path*`. The browser talks same-origin
`https://oldskoolseo.com/api/*` to Vercel; Vercel then proxies **server-side
over cleartext HTTP to a bare IP**. The `Authorization: Bearer <supabase JWT>`
header and all request bodies cross that cleartext hop.

The web client only ever calls relative `/api` (`apps/web/src/lib/api.ts:43,72`);
there is no browser-side configurable API origin. TLS terminates at Vercel for
the browser leg; there is **no** reverse-proxy/TLS config in the repository
(`deploy/` contains only systemd units and release scripts). The API listens on
`3001` by default and sets HSTS / trusts `X-Forwarded-*`, i.e. it already expects
an external TLS terminator.

### What is external / unknown

- whether a VPS reverse proxy exists and what hostname/cert it serves;
- the real production API hostname (`VPS_HOST` is a GitHub secret; only
  `oldskoolseo.com` is known from docs);
- whether `PUBLIC_APP_URL` is set on the VPS.

### Decision

- Replace the hardcoded cleartext IP in **both** `vercel.json` files with a
  stable HTTPS origin.
- **S7 is not marked COMPLETE** until the production path is actually end-to-end
  HTTPS; it is marked **INFRA ACTION REQUIRED** with the exact steps recorded in
  `docs/production-readiness-recon.md`.

### Resolution (2026-10-02)

Live probing changed the plan. Findings:

- `api.oldskoolseo.com` has no DNS record, so the first attempt
  (`https://api.oldskoolseo.com/api/:path*`) broke production with Vercel
  `502 DNS_HOSTNAME_NOT_FOUND`.
- The VPS (`144.172.102.63`) runs nginx and proxies `/api/*` on port 80
  to the API on `127.0.0.1:3001`; `GET http://<ip>/api/health` returns the SEO
  API for the default host. Port 443 later gained a Cloudflare Origin Certificate
  but its default server routes to the unrelated Bridge app, not the API.
- `peerdisco.com` is a Cloudflare zone whose origin is this same VPS.
  `www.peerdisco.com` is a different nginx server block (an unrelated "Bridge"
  app); on port 80 `api.peerdisco.com` does not match it and lands on the
  default server, i.e. our API.

Chosen origin: **`https://api.peerdisco.com/api/:path*`**. The Cloudflare `api`
DNS record is live, and Cloudflare SSL/TLS is set to **Full (strict)** with a
Cloudflare Origin Certificate installed on the VPS, so the whole path is intended
to be TLS end to end. One fix remains: on port 443 the VPS default server routes
`api.peerdisco.com` to the Bridge app (it answers `400 Invalid Host header`), so
`api.peerdisco.com` needs its own `listen 443 ssl` nginx server block that reuses
the Origin Certificate and proxies to `127.0.0.1:3001`. Both `vercel.json` files,
`deploy/vps/nginx-api.conf` (now the Cloudflare Origin Certificate variant) and
`deploy/README.md` are updated. S7 stays **INFRA ACTION REQUIRED** until that
block is applied and `https://api.peerdisco.com/api/health` returns the API.

No second API hostname beyond the `api.` subdomain is introduced.

---

## 3. Retry amplification — shared retry policy + budget

### Current state

- `apps/api/src/http/fetchTimeout.ts` bounds every outbound call (30s default).
- `apps/api/src/jobs/types.ts` classifies job failures (`jobErrorPayload`) and
  backs off job retries (`retryDelayMs`, cap 1h). Default `max_retries = 3`.
- `apps/api/src/jobs/postgresJobStore.ts` re-queues a failed job with backoff and
  increments `retry_count`.
- Only **DataForSEO** retries internally: `dataForSeoClient.ts` `request()` loops
  up to **4 attempts** with exponential backoff (`maxAttempts = 4`,
  `dataForSeoClient.ts:265`). Every other provider makes a single attempt and
  relies on the job retry (GSC/GA4 refresh a token once; WordPress, embeddings,
  Qdrant, X, OpenAI media do not retry).
- The worker's stale-running sweep (`worker.ts:33-47`) requeues a hung job
  (`status='running'`, older than 25 min) **without** incrementing `retry_count`,
  so a job that repeatedly crashes the worker can run forever.

### Amplification

`3 job retries × 4 DataForSEO attempts = 12` outbound calls for one logical
operation, and keyword/competitor jobs make many DataForSEO calls, each with its
own 4-attempt loop — effectively unbounded per job.

### Design

New shared module `apps/api/src/reliability/retry.ts`:

- `classifyRetry(err)` → `'transient' | 'rate_limited' | 'timeout' | 'auth' |
  'validation' | 'permanent'`, honouring an explicit `retryable` flag, timeout
  errors, the existing permanent-code set, then HTTP status (429/5xx/401/403/
  4xx). Precedence matters: an application code in the permanent set wins over
  the HTTP status, so `not_configured` (a deliberate 503) is never retried.
  Only `transient`, `rate_limited` and `timeout` are retryable.
- `RetryPolicy` + `retryDelayForAttempt` (exponential + jitter, capped).
- `withRetry(fn, { policy, provider, operation, breaker })` — bounded attempts,
  classification, structured logging (provider/operation/reason/attempt), and
  **no retry** for validation/auth/permanent.
- `RetryBudget` + `runWithRetryBudget` (AsyncLocalStorage) — a per-logical-
  operation cap on the number of retries shared by every nested provider call.

New module `apps/api/src/reliability/circuitBreaker.ts`:

- `CircuitBreaker` with `CLOSED → OPEN → HALF_OPEN → CLOSED`, a bounded
  cooldown, a half-open probe cap, per-provider registry
  (`getCircuitBreaker(name)`), state-transition logging, and
  `CircuitOpenError` (retryable, so a queued job backs off rather than hammering).
- `withRetry` consults the breaker when one is supplied: it refuses calls while
  open (throwing `CircuitOpenError` without an outbound request) and records
  success/failure to drive transitions.

### Budget semantics

The worker wraps each job **execution** in
`runWithRetryBudget(new RetryBudget(config.retry.perJobBudget))`
(`RETRY_PER_JOB_BUDGET`, default 4). Every nested provider retry consumes one
unit; when exhausted, `withRetry` stops retrying and throws, letting the job
retry policy (existing `max_retries` + `retryDelayMs`) decide. Worst-case
provider retries for a logical job become
`(max_retries + 1) × RETRY_PER_JOB_BUDGET` **total across all calls in the job**,
instead of "per call". Documented limits: `RETRY_PER_JOB_BUDGET=4`,
`max_retries=3` → ≤ 16 shared provider retries per logical job.

### Stale-running sweep

Increment `retry_count` when requeueing a stale running job; jobs that would
exceed `max_retries` are terminally failed with a `stale_worker` error instead of
being requeued forever. This bounds a job that repeatedly kills the worker.

---

## 4. RLS isolation matrix

### Current state

All 36 `seo_*` tables have RLS enabled. Two are deliberate deny-all with no
policy (`seo_credentials`, `seo_platform_admins`). Platform-admin visibility is a
separate service-role trust boundary (`seo_platform_admins` + SECURITY DEFINER
RPCs), never a table policy. The migration harness
(`scripts/db-migrate-local.sh`) currently exercises leakage for ~11 tables only
(see matrix below); 21+ tables have no explicit `authenticated`-role isolation
check.

### Design

Extend `scripts/db-migrate-local.sh` with:

1. a **schema-generated** SELECT-isolation loop over every `seo_*` table in
   `information_schema.columns` that has a `project_id` column (32 tables; the
   list is generated, never hard-coded). The unrelated authenticated non-member
   probe must have the policy evaluate and return exactly zero rows - a
   permission error there is a real regression and fails the harness. The `anon`
   probe may return zero rows **or** a hard `insufficient_privilege` denial (the
   membership helpers are granted to `authenticated` only, so policy evaluation
   itself rejects anon); both are denials. Any other error, or a non-zero count,
   fails the harness.
2. focused negative tests (SELECT/INSERT/UPDATE/DELETE + FK) for the high-risk
   set: projects, project_members, content, content_media, sync_jobs,
   usage_events, credentials, api_keys, publications, integrations, audit_logs,
   media.
3. platform-admin assertions: no ordinary table policy references
   `seo_is_platform_admin`, no `USING (true)` policy exists on a customer table,
   and the admin helper/RPCs remain `service_role`-only.

Expected access follows the existing authorization model (owner/editor writes,
member reads, owner/admin deletes), not a new one. Platform-admin behavior is
unchanged.

### Ownership model (for the matrix)

`auth.users → seo_accounts (owner_user_id) → seo_projects.account_id →
project-scoped rows`. Project RLS is **membership-based**
(`seo_is_member` / `seo_has_role`); account identity additionally grants
`seo_accounts`, account-scoped integrations, the GSC property registry and
account-scoped usage rows. Platform-admin access never flows through membership.

---

## 5. Deferred / infra-only items

- **S7**: external DNS + TLS termination for the API subdomain; documented as
  INFRA ACTION REQUIRED, repository config made ready.
- Process-local rate limiter and circuit breaker are **per process**. With the
  current single-API/single-worker systemd topology that is the real protection;
  if the API is later scaled horizontally, a shared store (Redis/table) can
  replace them behind the existing interfaces. Documented in both modules.
