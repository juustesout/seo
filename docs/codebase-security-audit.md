# Codebase security & quality audit

Date: 2026-10-01
Scope: full repository (`packages/contracts`, `apps/api`, `apps/web`,
`supabase/migrations`) — read-only deep dives plus direct verification of every
high-severity claim, then a P0 remediation pass.

Method: five parallel area reviews (API security, RLS/data layer, web
frontend, reliability/quality, provider/integration) consolidated and
de-duplicated; the top claims (CORS, SSRF, raw-HTML sinks, RLS grants) were
re-verified by reading the exact source lines and, for RLS, by running the real
migrations against a local PostgreSQL 15 and probing the policies.

Scale: apps/api 208 src / 152 test files; apps/web 174 src / 86 test files;
packages/contracts 44 src / 28 test files; 31 route files; 53 service files;
34 migrations; 18 MCP tools; 36 `seo_*` tables (RLS enabled on all).

---

## 1. Fixed in this pass (P0)

### S1 — Stored/click XSS via unvalidated link schemes (High) — FIXED
Rendered HTML escaped text but not the URL scheme, so a `javascript:`/`data:`
`href` survived into a persisted anchor and executed on click at the raw
`dangerouslySetInnerHTML` sinks.

- Root cause fixed in the single authoritative renderer:
  `packages/contracts/src/content.ts` (`safeHref` + link block) and
  `packages/contracts/src/contentDoc.ts` (link mark + composition button).
  Unsafe schemes now render as plain text, never as `<a>`.
- Defense in depth at the sinks: new `apps/web/src/lib/sanitizeHtml.ts`
  (`sanitizeArticleHtml`, `safeImageSrc`) parses the stored HTML with
  `DOMParser`, drops active content (`script`/`style`/`iframe`/`svg`/...),
  strips `on*` and `style` attributes, and rewrites `href`/`src` through a
  scheme allowlist. Wired into `apps/web/src/views/EditorView.tsx` and
  `apps/web/src/components/content/WriterPanel.tsx`.
- Tests: `packages/contracts/src/contentHtmlSafety.test.ts` (8),
  `apps/web/src/lib/sanitizeHtml.test.ts` (12).

### S2 — WordPress `base_url` SSRF + credential exfiltration (High) — FIXED
`publishers.ts` accepted any non-empty `base_url`
(`z.string().url().or(z.string().min(1))`) and `wordpress.ts` fetched it with a
Basic auth header, so an editor could point it at cloud metadata or an internal
host.

- Route validation: `apps/api/src/http/routes/publishers.ts` runs `base_url`
  through the existing SSRF guard `validateExternalUrl`
  (`apps/api/src/knowledge/url.ts`) and rejects non-public/non-http(s) targets
  with a 400.
- Defense in depth: `apps/api/src/providers/wordpress.ts` `clientFor` validates
  the resolved URL before any request, so stored/legacy config cannot bypass it.
- Tests: `apps/api/src/providers/wordpress.test.ts` (private IP and non-http
  scheme rejected before `fetch`).

### S6 — CORS failed open when the allow-list was empty (High) — FIXED
`apps/api/src/app.ts` reflected **any** `Origin` with
`access-control-allow-credentials: true` when `CORS_ORIGINS`/`PUBLIC_APP_URL`
were unset. Now it reflects an origin only when it is explicitly allow-listed
(fail closed). Same-origin and non-browser callers (no `Origin`) are
unaffected.
- Test: `apps/api/src/app.test.ts` (non-allow-listed origin gets no ACAO,
  allow-listed origin is reflected with credentials).

### S8 — OAuth signed state had no expiry (High) — FIXED
`apps/api/src/infra/signedPayload.ts` now embeds `iat`/`exp` (default 30 min)
and `verifyJsonPayload` rejects expired tokens, removing replay of captured
consent states. Existing GSC/GA4/X flows are covered with no caller changes.
- Test: `apps/api/src/infra/oauthFlow.test.ts` (round-trip + expired rejection).

### S11 — No security headers on the API (Medium) — FIXED
`apps/api/src/app.ts` now sets `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`, a
lockdown `Content-Security-Policy` and HSTS on every response.
- Test: `apps/api/src/app.test.ts`.

### S3/S4 — RLS: creator backdoor + over-exposed definer helpers (High) — FIXED
New migration `supabase/migrations/20260101000034_harden_rls_security.sql`:

- **Creator backdoor removed.** `seo_projects` (and
  `seo_project_members_select`) granted access on `created_by = auth.uid()`
  independently of membership. Since the creator is inserted as owner by
  `seo_projects_add_owner_membership`, that was a redundant ownership path that
  survived removal/demotion and could not be revoked. Policies now resolve
  access purely through `seo_is_member`/`seo_has_role`.
- **Definer-helper exposure reduced.** The helpers carried the default PUBLIC
  EXECUTE grant, so `anon`/`authenticated` could call them as RPCs with an
  arbitrary user id (membership/account enumeration) and `seo_ensure_account`
  could create accounts.

  Important correction to the initial recommendation: `seo_is_member`,
  `seo_has_role` and `seo_account_id_for_user` **must keep** `authenticated`
  EXECUTE, because RLS policy expressions run with the invoking role's
  privileges. This was verified empirically against PostgreSQL 15 — revoking
  from `authenticated` makes every project read fail with
  `permission denied for function`. The fix therefore revokes `public, anon`
  for those three (closing the unauthenticated oracle) and grants
  `authenticated, service_role`. `seo_ensure_account` is a write helper reached
  only through SECURITY DEFINER triggers, so it is revoked from
  `authenticated` entirely and granted to `service_role` only (the definer
  trigger path still works, also verified empirically).
- Smoke checks added to `scripts/db-migrate-local.sh` (removed creator loses
  project access; anon cannot execute the helpers; authenticated retains the
  RLS helpers; the write helper is service-role only).

Verification of this pass (all green):
`@seo/contracts` build + 506 tests; `@seo/api` typecheck + build + 1891 tests;
`@seo/web` typecheck + 778 tests; migration harness on a fresh database
(`DB_NAME=seo_p0_smoke bash scripts/db-migrate-local.sh`) including the new
hardening checks.

Also made deterministic (pre-existing, date-fragile): the GSC keywords test
used fixed September dates against the route's "last 28 days" default window,
so it failed once the calendar moved past the fixture dates. It now passes an
explicit range.

---

## 2. Top 5 ways to improve the codebase

1. **Input validation & output encoding.** Beyond S1/S2: validate/guard
   remaining external-URL fetches (image acquisition follows redirects past the
   allowlist; `competitorResearch` query isn't validated). Prefer a single
   shared fetch-URL module.
2. **Perimeter and transport.** Rate limiting is now in place (global IP/user
   tiers plus OAuth/expensive/job endpoint classes, S5 FIXED). S7 is FIXED: both
   `vercel.json` files target `https://api.peerdisco.com/api/:path*`; the
   Cloudflare `api` DNS record is live, SSL/TLS is Full (strict) with a
   Cloudflare Origin Certificate on the VPS, and the
   `deploy/vps/nginx-api.conf` 443 block proxies `api.peerdisco.com` to
   `127.0.0.1:3001` (verified end-to-end: `api.peerdisco.com/api/health` and
   `oldskoolseo.com/api/health` both `200`). A CSP/header set for the web app is
   still open.
3. **Observability and resilience.** Request/correlation ids, DB/Qdrant
   readiness, and outbound timeouts are in place. Retry amplification is bounded
   by a shared classifier + per-job retry budget (DataForSEO's internal loop now
   goes through `withRetry`), a per-provider circuit breaker refuses calls while
   open, and the worker stale-job sweep now counts a crash as an attempt
   (`stale_worker` terminal past `max_retries`).
4. **Data-layer integrity.** S12–S16 are fixed (see migration
   `20260101000035_harden_data_integrity.sql`). RLS isolation is now
   schema-generated across every project-scoped `seo_*` table plus focused
   write-denial and platform-admin boundary checks in the migration harness.
5. **Engineering process & supply chain.** No ESLint/Prettier or `lint` script;
   CI never runs the migration harness or contracts tests; no coverage,
   dependency/secret scanning, or Dependabot; API tsconfig disables
   `noUncheckedIndexedAccess`; config-read drift (modules reading `process.env`
   directly, no `.env.example`); no web code-splitting; dead code and
   duplicated test helpers.

---

## 3. Remaining findings (severity)

Status as of 2026-10-02: **S5 FIXED**, **S7 FIXED**, **S9 FIXED**, **S10
FIXED**, **S12–S16 FIXED**. Rows are retained unchanged as the original audit
snapshot.

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| S7 | High | API rewrite over cleartext HTTP to a hardcoded IP (bearer in plaintext) | `apps/web/vercel.json`, root `vercel.json` |
| S5 | High | No rate limiting anywhere | `apps/api/src/app.ts`, `apps/api/package.json` |
| S9 | Med | Internal DB/vendor error text leaked to clients (REST + MCP) | `supabase.ts`, `apiErrors.ts`, `mcp/http.ts` |
| S10 | Med | MCP HTTP sessions never expire / are not re-authorized; unbounded map | `apps/api/src/mcp/http.ts` |
| S12 | Med | Project deletion likely fails (audit FK vs trigger) | `...00005_jobs_publishing.sql`, `...00006_rls.sql` |
| S13 | Med | Cross-project content↔media linking (no `project_id` on link table) | `...00015_media.sql` |
| S14 | Med | Public media bucket, no `storage.objects` policies | `infra/mediaStorage.ts` |
| S15 | Med | `idempotency_key` unique globally, not per project | `...00005_jobs_publishing.sql` |
| S16 | Med | `seo_usage_totals` revoke only `from public` | `...00031_usage_events.sql` |
| L1 | Low | API-key hash compared non-constant-time | `apiKeys.ts` |
| L2 | Low | Logger redaction misses `token`/`api_key`/`secret` | `logger.ts` |
| L3 | Low | `/api/health` discloses configured providers | `app.ts` |
| L4 | Low | State HMAC reuses the encryption key | `publisherOAuthService.ts` |
| L5 | Low | Audit-log `user_id` clause allows cross-project reads | `...00006_rls.sql` |
| L6 | Low | `seo_api_keys.scopes` has no CHECK; invite email enumeration; non-idempotent/destructive migrations; missing consolidated `dist/supabase-schema.sql` | various migrations |
| L7 | Low | Image fetch follows redirects past the allowlist; unvalidated `competitorResearch` query | `externalImageAcquisition.ts`, `competitorResearch.ts` |

Note on S4: the three RLS helper functions remain callable by `authenticated`
(out of RLS necessity, verified). Full closure of the authenticated membership
oracle would require policies to call an `auth.uid()`-only wrapper; that is a
larger, cross-cutting migration and is deferred.

---

## 4. What is already solid (keep)

- JWT issuer/audience pinned with a single 401 on failure.
- Per-request `requireRole` plus a platform-admin registry as a separate trust
  boundary.
- AES-256-GCM credentials with per-row IV/auth tag; API keys stored hashed and
  shown once.
- RLS enabled on all 36 tables, no `USING (true)` / `TO anon`; `seo_credentials`
  deny-all; definer functions pin `search_path = ''`.
- Durable job queue with `FOR UPDATE SKIP LOCKED`, LISTEN/NOTIFY, exponential
  backoff and project-scoped idempotency.
- Honest capability reporting (503 `not_configured`, no fabricated zeros) and a
  shared `{ data }` / `{ error }` envelope; strict TS with no `@ts-ignore`.

---

## 5. Roadmap

- **P0 — done** (S1, S2, S3, S4, S6, S8, S11).
- **P1 — mostly done:**
  - Error sanitization (S9) and MCP session TTL/cap/re-auth (S10).
  - Data-layer fixes (S12–S16): migration
    `20260101000035_harden_data_integrity.sql` (project-teardown audit,
    project-bound content<->media links, per-project job idempotency,
    `seo_usage_totals` grant, `storage.objects` policies for `seo-media`).
  - Request/correlation ids, liveness-only `/api/health`, new DB-aware
    `/api/ready` (now the deploy gate), and expanded logger redaction (L2/L3).
  - Outbound timeouts on every provider HTTP client.
  - Rate limiting (S5): global IP/user tiers plus OAuth/credential, expensive
    provider and job-creation endpoint classes.
  - Shared retry policy + per-job retry budget and a per-provider circuit
    breaker; worker stale running sweep now advances `retry_count`.
  - RLS isolation matrix expanded to every project-scoped `seo_*` table
    (schema-generated) plus focused write-denial and platform-admin boundary
    checks.
  - S7 HTTPS API origin resolved: Vercel -> `https://api.peerdisco.com` ->
    Cloudflare Full (strict) -> VPS nginx 443 (Origin Certificate) -> API,
    verified end to end on 2026-10-02.
  - **P1 remaining:** none of the original four items; see the P2 list below.
- **P2 — done:**
  - ESLint flat config (`eslint.config.mjs`): 0 errors, remaining warnings are
    `react-hooks/exhaustive-deps` / `no-explicit-any` (advisory).
  - CI (`.github/workflows/ci.yml`): build/lint/typecheck/tests-with-coverage/
    artifact plus `migrations` (fresh `postgres:15`, `scripts/db-migrate-local.sh`)
    and `security` (trufflehog secret scan + `pnpm audit --prod
    --audit-level=critical`) jobs; `.github/dependabot.yml` added.
  - Coverage thresholds per package (`@vitest/coverage-v8`, ~2 pts below
    measured) for contracts, api and web.
  - `noUncheckedIndexedAccess` enabled for `@seo/api` including tests (0 errors).
  - Config consolidated in the `config.ts` zod schema (`EMBEDDINGS_*`,
    `MCP_API_KEY`); services read `container.config.env`; `.env.example` added
    for `apps/api` and `apps/web`.
  - Web route code-splitting via `lazy()` + `Suspense` (`apps/web/src/App.tsx`);
    production build emits per-route chunks.
  - Dead code removed through lint.
  - **P2 remaining:** none.
