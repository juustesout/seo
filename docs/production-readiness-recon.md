# Production Readiness Recon

Date: 2026-09-29

Scope: Vercel production, production Supabase, Google OAuth, Google Search
Console (GSC), CI / GitHub workflow and branch protection.

This document is RECON ONLY. No code, configuration, migrations, OAuth
settings or secrets were changed. All statements are derived from repository
evidence; anything that depends on Vercel, Supabase, Google Cloud or GitHub
dashboards is classified as requiring external verification rather than as a
defect. No secret values appear here.

Objective: turn "Google OAuth doesn't work yet" into a precise production
readiness finding.

---

## A. Current production topology

What actually exists today, reconstructed from the repository.

```
Browser (https://oldskoolseo.com)
  |
  |  Vercel serves the React/Vite SPA (apps/web)
  |  vercel.json rewrites:
  |    /api/:path*  ->  http://144.172.102.63/api/:path*
  |    /(.*)        ->  /index.html          (SPA fallback)
  v
VPS 144.172.102.63  (API + worker, port 3001)
  /opt/seo-api/current -> releases/<release-id>   (prebuilt dist only)
  systemd: seo-api.service, seo-worker.service
  /opt/seo-api/shared/.env  (mode 600, loaded by systemd)
  |
  v
Hosted Supabase project (system of record: Postgres + Auth + Storage)
  migrations applied out of band, never by the pipeline
```

| Element | Evidence | Classification |
| --- | --- | --- |
| Web SPA on Vercel at `oldskoolseo.com` | `vercel.json:1-12`, `apps/web/vercel.json:1-12`; user-stated domain | Confirmed (deployed) |
| API base for the browser is same-origin `/api` | `apps/web/src/lib/api.ts:43` uses relative `/api...` | Confirmed implemented |
| Vercel proxies `/api/*` to the VPS | `vercel.json:4-6` (`http://144.172.102.63/api/:path*`) | Confirmed in code; runtime behavior needs live test |
| API + worker run on one VPS | `deploy/systemd/seo-api.service`, `seo-worker.service`; `deploy/README.md:53-74` | Confirmed |
| API build/test happen in CI, not the VPS | `.github/workflows/ci.yml:56-66`, `deploy/build-artifact.sh` | Confirmed |
| Deploy runs only after CI succeeds on `main` | `.github/workflows/deploy.yml:4-7,19-22` | Confirmed |
| Migrations are never applied by the pipeline | `deploy/README.md:158-171` | Confirmed (manual process) |
| Supabase is the system of record | `apps/api/src/context.ts:84-100`, `apps/api/src/supabase.ts:41-48` | Confirmed |
| File/media storage is Supabase Storage, not local disk | `apps/api/src/infra/mediaStorage.ts:20`, `apps/api/src/infra/knowledgeFileStorage.ts:19` | Confirmed |
| Reverse proxy on the VPS forwarding port 80 -> 3001 | Not present in the repository | Unclear (ops configuration) |
| Domain/TLS in front of the VPS | Vercel rewrite uses plain `http` to a bare IP; TLS terminates at Vercel | Confirmed in code; no VPS-side TLS required for the browser path |

Production build command: the repository has **no** committed Vercel build
command, install command or output directory (`vercel.json` contains only
`rewrites`). CI builds `@seo/contracts`, then `@seo/api`, then `@seo/web`
(`.github/workflows/ci.yml:35-54`). The Vercel project consequently depends on
dashboard-side build settings that cannot be verified from the repository (see
Finding M2).

Callback / redirect URLs:

- GSC OAuth callback is constructed at runtime as
  `${redirectBase(req)}/api/oauth/gsc/callback`
  (`apps/api/src/http/routes/oauth.ts:86`, `account.ts:207`, `integrations.ts:272`).
- `redirectBase` returns `PUBLIC_APP_URL` when set, otherwise
  `${req.protocol}://${req.get('host')}` (`apps/api/src/http/routes/utils.ts:33-37`).
- Therefore the production authorized redirect URI is
  `https://oldskoolseo.com/api/oauth/gsc/callback` **only if** `PUBLIC_APP_URL`
  is set on the VPS. Otherwise it falls back to the proxied request host, which
  behind the Vercel rewrite is expected to be the VPS host/IP, not the public
  domain.

Preview/staging distinctions: none in code. The single `vercel.json` rewrite
points every environment (including preview deployments) at the same production
VPS API (`vercel.json:5`), and the API has no per-environment switch beyond
`NODE_ENV` defaults (`apps/api/src/config.ts:30`). See Finding M4.

---

## B. Vercel assessment

Confirmed from repository evidence:

- `vercel.json` (repo root) and `apps/web/vercel.json` are identical: a `/api`
  proxy rewrite plus an SPA catch-all. There are no headers, redirects,
  `buildCommand`, `installCommand`, `outputDirectory` or `framework` keys.
- The client never hardcodes an API host or localhost: `apps/web/src/lib/api.ts`
  uses relative `/api`, and no `localhost`/`127.0.0.1`/`http://` string exists
  under `apps/web/src` or `apps/web/index.html`.
- The dev server proxy in `apps/web/vite.config.ts:16-21` targets
  `http://localhost:3001`; this is dev-only and does not affect production.
- Server/client env split is correct: only `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` are read in the browser
  (`apps/web/src/lib/supabase.ts:17-18`); the service-role key is read only in
  `apps/api/src/config.ts` / `context.ts` and is never bundled.

Requires external verification:

- **Build command / output directory.** The web bundle imports runtime values
  from `@seo/contracts` (for example `DOCUMENT_OPERATIONS_VERSION`,
  `contentRevisionOf`, `tiptapEmptyDoc` in `apps/web/src/views/Designer.tsx`,
  `apps/web/src/views/Compose.tsx`), and `@seo/contracts` resolves to
  `dist/index.js` (`packages/contracts/package.json`). `dist/` is gitignored
  (`.gitignore:2`). A Vercel build that runs only `@seo/web` would fail unless
  `@seo/contracts` is built first. The required build ordering is encoded in
  the root script (`package.json: "build"`) and in CI, but not in `vercel.json`.
- **`/api` proxy reachability.** The rewrite target is a bare IP over plain
  HTTP with no path rewriting or header controls. Whether Vercel proxies
  external requests to this IP for all methods (including POST bodies and the
  unauthenticated OAuth callback redirects) must be confirmed with a live
  production request.
- **Environment variables.** `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
  must be present in Vercel build settings; they are build-time inlined by Vite
  and are required or the app shows a boot error
  (`apps/web/src/App.tsx:136-140`).

---

## C. Supabase assessment

Confirmed from repository evidence:

- The API uses a **service-role** client with `persistSession: false` /
  `autoRefreshToken: false` (`apps/api/src/supabase.ts:41-48`). This client
  bypasses RLS, so authorization is re-derived per request from
  `seo_project_members` via `AccessService.requireRole`
  (`apps/api/src/supabase.ts:130-166`) and `requireAccount`
  (`apps/api/src/supabase.ts:168-182`).
- The browser uses the anon key only, with `persistSession`/`autoRefreshToken`
  enabled (`apps/web/src/lib/supabase.ts:22-24`). RLS is the boundary for direct
  anon traffic.
- JWT verification pins issuer to `https://<host>/auth/v1` and audience to
  `authenticated`, using JWKS (RS256) with an optional HS256 fallback
  (`apps/api/src/auth/jwt.ts:59-84`). This accepts tokens from any Supabase auth
  method, including a future Google provider.
- Accounts are created lazily and idempotently via `seo_ensure_account`
  (`apps/api/src/supabase.ts:173-182`, migration
  `20260101000011_accounts.sql`), so a Google-authenticated user would resolve
  an account without extra code. Migration
  `20260101000013_account_scoped_integrations.sql` makes `project_id` nullable
  and enforces "project OR account" scope plus one active account-level
  connection per provider.
- Migrations 000001 through 000031 exist under `supabase/migrations/`.
- Supabase Storage buckets `seo-media` (public) and `seo-knowledge` (private)
  are created on demand by the service-role client
  (`mediaStorage.ts:29-32`, `knowledgeFileStorage.ts:38-41`).

Requires external verification / unclear:

- **Hosted schema parity.** There is no `supabase/config.toml`, no linked
  project reference and no committed schema snapshot. `CLAUDE.md` refers to
  `dist/supabase-schema.sql` as the consolidated manual-paste artifact, but that
  path does not exist in the repository tree. Whether the hosted project has all
  31 migrations applied cannot be determined from the repository. See Finding
  M3.
- **RLS edge cases on account-scoped rows.** Account-scoped integrations
  (`project_id NULL`) rely on the account policies added in migration 13; this is
  code-consistent but its live behavior against the hosted project needs a smoke
  test.
- **Auth configuration.** Whether the hosted project has a Site URL, redirect
  allow-list, email provider and (future) Google provider configured is a
  dashboard concern, not verifiable here.

No localhost/dev Supabase URL appears anywhere in the sources.

---

## D. Google OAuth (application login)

Complete trace as implemented today:

```
browser
  -> AuthScreen (email/password, sign-up, magic link / one-time code)
  -> supabase.auth.signInWithPassword | signUp | verifyOtp | signInWithOtp
  -> Supabase Auth issues a session
  -> lib/api.ts attaches Authorization: Bearer <access_token>
  -> API optionalAuth -> verifyAccessToken (issuer/audience pinned)
  -> authenticated request; /me resolves projects/account
```

Evidence: `apps/web/src/App.tsx:621-749` (AuthScreen) calls only
`signInWithPassword`, `signUp`, `verifyOtp`, `signInWithOtp`. A repository-wide
search finds **no** `signInWithOAuth` call, no Google login button and no Google
provider reference in the web client.

Classification:

- **Code-complete (for a future provider):** session persistence, the
  `onAuthStateChange` subscription (`App.tsx:157-164`), the bearer-token bridge
  (`lib/api.ts:41-50`), and server-side JWT verification with issuer/audience
  pinning (`auth/jwt.ts:59-84`) all already work for any Supabase auth method.
  `createClient` uses Supabase JS defaults, which include URL session detection.
- **Actually missing:** the Google **initiation** code path. There is no
  `signInWithOAuth({ provider: 'google' })` call and no Google button in
  `AuthScreen`, and no `redirectTo` is supplied anywhere.
- **External-config dependent:** enabling the Google provider in Supabase Auth,
  registering the Supabase callback `https://<project-ref>.supabase.co/auth/v1/callback`
  as an authorized redirect URI in Google Cloud, and setting the Supabase Site
  URL / redirect allow-list to `https://oldskoolseo.com`.

The exact current gap: Google login is not implemented in the UI at all. The
application's email/password and magic-link flows are implemented, so the
platform is deployable and usable today without Google login.

---

## E. Google Search Console assessment

This is a **separate OAuth client** from application login: a server-held
confidential client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`,
`config.ts:48-50`), not the Supabase Google provider
(`apps/api/src/providers/gsc/oauth.ts:1-13`).

Complete trace as implemented:

```
authenticated app user
  -> GET /api/account/gsc/connect-url (or /api/projects/:id/integrations/:id/oauth-url)
  -> create/reuse seo_integrations row (account-scoped, project_id NULL)
  -> buildAuthorizationUrl (scope webmasters.readonly + openid + email,
     access_type=offline, prompt=consent)
  -> signed state (CREDENTIALS_ENCRYPTION_KEY) carries account/project + integration
  -> Google consent
  -> GET /api/oauth/gsc/callback (unauthenticated browser redirect)
     -> verify signed state
     -> confirm integration still belongs to account/project
     -> exchangeCode (client_id + client_secret) at oauth2.googleapis.com/token
     -> store encrypted access + refresh token under the integration
     -> mark integration connected, redirect back into the app
  -> property discovery via GET /sites
  -> Search Analytics via POST /sites/<siteUrl>/searchAnalytics/query
```

Evidence: `apps/api/src/http/routes/oauth.ts:39-111`,
`apps/api/src/http/routes/account.ts:157-281`,
`apps/api/src/http/routes/integrations.ts:256-304`,
`apps/api/src/providers/gsc/oauth.ts`, `apps/api/src/providers/gsc/gscDataSource.ts`,
`apps/api/src/providers/gsc/gscApi.ts:34` (base
`https://searchconsole.googleapis.com/webmasters/v3`), token refresh on 401 in
`gscDataSource.ts:142-160`, encrypted storage via `container.credentials`
(`infra/credentials.ts`, AES-256 with `CREDENTIALS_ENCRYPTION_KEY`).

Blocked by which factor:

1. Basic Google OAuth (application login) - **not** a dependency. GSC uses a
   separate server-side client.
2. Missing GSC scopes - **no**; `webmasters.readonly` + `openid` + `email` are
   requested (`oauth.ts:18-22`).
3. Google Cloud API configuration - **possible external requirement**: the
   Search Console API must be enabled for the Cloud project, the consent screen
   must include the `webmasters.readonly` scope, and the client type must be
   Web application.
4. Callback configuration - **external requirement**: the authorized redirect
   URI must be `https://oldskoolseo.com/api/oauth/gsc/callback`, which in turn
   requires `PUBLIC_APP_URL=https://oldskoolseo.com` on the VPS.
5. Token persistence/refresh - **implemented** (encrypted store, 401 refresh,
   disconnect clears tokens).
6. Application code - **implemented**; no defect found in the traced flow.
7. Production environment configuration - **required and unverifiable**:
   `PUBLIC_APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
   `CREDENTIALS_ENCRYPTION_KEY` must all be present on the VPS. The
   `/api/health` endpoint exposes only the derived `google` and
   `credentials_encryption` booleans (`app.ts:98-111`), so presence is
   observable without reading values.

The exact current gap: GSC is code-complete but its production operation depends
on external Google Cloud + VPS env configuration that cannot be verified from
the repository.

---

## F. Google Cloud configuration dependencies

For each item, repository evidence and what must be verified externally.

| Required external configuration | Repository evidence | Verification |
| --- | --- | --- |
| GSC OAuth consent screen with `webmasters.readonly` scope | `providers/gsc/oauth.ts:18-22` | Google Cloud console |
| OAuth client type "Web application" with a client secret | `oauth.ts:69-98` server-side confidential flow; `config.ts:48-50` | Google Cloud console |
| Authorized redirect URI `https://oldskoolseo.com/api/oauth/gsc/callback` | Derived from `PUBLIC_APP_URL` + `/api/oauth/gsc/callback` (`routes/utils.ts:33-37`, `oauth.ts:86`) | Google Cloud console |
| Search Console API enabled | `gscApi.ts:34` calls `searchconsole.googleapis.com/webmasters/v3` | Google Cloud console |
| Test vs published publishing status / test users | None in repository | Google Cloud console |
| Supabase Google login provider enabled | No provider reference in code; Supabase dashboard owns it | Supabase dashboard |
| Supabase callback `https://<ref>.supabase.co/auth/v1/callback` authorized in Google | Not in repository | Google Cloud console |
| Supabase Site URL / redirect allow-list includes `https://oldskoolseo.com` | Not in repository | Supabase dashboard |
| VPS env: `PUBLIC_APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, Supabase keys | `config.ts:29-104`; `deploy/README.md:64-74` | VPS `/opt/seo-api/shared/.env` (presence only) |

---

## G. CI / branch protection assessment

Workflow inventory (`.github/workflows/`):

- `ci.yml` runs on every `pull_request`, on `push` to `main`, and via
  `workflow_dispatch` (`ci.yml:3-7`). It installs with a frozen lockfile, builds
  contracts, then typechecks/tests/builds the API and typechecks/tests/builds
  the web app (`ci.yml:32-54`). On `main` it packages and uploads the API
  artifact for 14 days (`ci.yml:56-66`). No secrets are required; it is a pure
  build/test job.
- `deploy.yml` triggers on `workflow_run` completion of `CI` on `main`, runs in
  a GitHub `Production` environment, and only deploys when CI concluded
  successfully (`deploy.yml:4-7,19-22`). It needs `VPS_HOST`, `VPS_USER`,
  `VPS_SSH_KEY` (and optional `VPS_PORT`, `VPS_KNOWN_HOSTS`, `VPS_SERVICE_USER`,
  `VPS_HEALTH_URL`, `deploy/README.md:40-48`).

Coverage summary:

| Check | Where | Blocks merge? |
| --- | --- | --- |
| contracts build | `ci.yml:35-36` | Only if branch protection requires the CI check |
| API typecheck + test + build | `ci.yml:38-45` | Same |
| web typecheck + test + build | `ci.yml:47-54` | Same |
| API artifact packaging | `ci.yml:56-66` (main only) | n/a |
| Migration validation | **not run in CI** | n/a |
| `scripts/db-migrate-local.sh` | **not run in CI** | n/a |

Concrete gaps:

- CI does not validate migrations or run the local migration harness, even
  though production schema is applied manually. A broken migration therefore
  cannot fail CI (Finding M3).
- CI does not exercise the Vercel build path; the `contracts -> web` build-order
  dependency exists only as a root script that CI happens to call.
- `deploy.yml` deploys the API on **every** successful CI run on `main`,
  including docs-only commits, because it keys only on CI success
  (`deploy.yml:19-22`). It is not a correctness gap but increases deploy churn.

---

## H. Branch protection assessment

No branch-protection configuration, ruleset, `CODEOWNERS` or settings file
exists in the repository (`.github/` contains only the two workflows).

Classification: **External GitHub configuration requiring verification.**

Whether `main` can receive changes without required checks cannot be determined
from the repository. The minimum protection consistent with the existing CI is:
require a pull request before merging; require the `CI` workflow's `build`
check; disallow direct pushes to `main`; optionally dismiss stale approvals and
restrict force-pushes. No GitHub settings were changed.

---

## I. Production smoke path

Minimum path and where it can currently fail, based on repository evidence:

```
https://oldskoolseo.com
  -> SPA loads (Vercel; requires VITE_SUPABASE_* at build time)      [needs live test]
  -> email/password login                                            [code-complete]
     (Google login: NOT implemented)                                 [missing]
  -> authenticated session -> Authorization: Bearer <supabase JWT>   [code-complete]
  -> /api/me via Vercel -> VPS(:3001) proxy                          [needs live test]
  -> project access (requireRole)                                    [code-complete]
  -> Google integration (account connect-url)                        [code-complete]
  -> GSC property connection                                         [external config]
  -> core GSC API request (search analytics)                         [external config]
```

Verified from code: session bootstrap, JWT verification, project/account
authorization, GSC OAuth construction, token storage/refresh, GSC API client.

Verified from workflow/configuration: CI build/test gate; artifact-based deploy
with health check and rollback.

Requires live production test: SPA load with production env; the Vercel -> VPS
`/api` proxy for real requests and the OAuth callback redirect hop.

Requires external dashboard verification: Google Cloud OAuth client, consent
screen, enabled Search Console API, Supabase Google provider, Supabase redirect
allow-list, VPS environment variables.

No test results are claimed here because none can be executed from the
repository against live production.

---

## J. Environment matrix

Only evidence-supported cells are populated; everything else is `unknown`.

| Capability | Local | Preview | Production | Evidence | External config required |
| --- | --- | --- | --- | --- | --- |
| Vercel deployment | n/a | unknown | deployed (SPA + `/api` rewrite) | `vercel.json`; user-stated domain | Vercel build command / env vars |
| Supabase | works (local harness) | unknown (shares prod API) | in use (system of record) | `context.ts`, migrations, `supabase.ts` | Hosted schema parity, Auth settings |
| Basic Google OAuth | not implemented | unknown | not implemented | no `signInWithOAuth`; `App.tsx:621-749` | Supabase Google provider + Google client |
| GSC OAuth | code-complete | unknown (shares prod API) | code-complete | `routes/oauth.ts`, `providers/gsc/*` | Google client + redirect URI + `PUBLIC_APP_URL` + encryption key |
| GSC API | code-complete | unknown | code-complete | `gscApi.ts:34` | Search Console API enabled + scope approved |
| CI | runs locally via scripts | runs on PR | runs on `main` | `ci.yml` | none |
| Branch protection | n/a | n/a | unknown | no config in repo | GitHub settings |

---

## Findings

### Blocker

**B1. Google login initiation is not implemented.**
- Location: `apps/web/src/App.tsx:621-749` (`AuthScreen`); no
  `signInWithOAuth` anywhere in the repository.
- Current behavior: only email/password, sign-up, magic-link and one-time-code
  flows exist. There is no Google button and no `redirectTo`.
- Consequence: production Google OAuth login cannot operate; the stated goal of
  "production Google OAuth" is unmet.
- Smallest remediation boundary: one `supabase.auth.signInWithOAuth({ provider:
  'google', options: { redirectTo } })` action plus a button in `AuthScreen`.
- Remediation type: code (plus external Supabase/Google configuration below).

### High

**H1. GSC production redirect URI depends on `PUBLIC_APP_URL` being set on the VPS.**
- Location: `apps/api/src/http/routes/utils.ts:33-37`, `oauth.ts:86`,
  `account.ts:207`.
- Current behavior: with `PUBLIC_APP_URL` unset, the redirect base falls back to
  the proxied request host, which behind the Vercel rewrite is expected to be the
  VPS host/IP rather than `oldskoolseo.com`.
- Consequence: the Google redirect URI would not match the authorized URI and
  GSC connect would fail at consent/callback.
- Smallest remediation boundary: set `PUBLIC_APP_URL=https://oldskoolseo.com` in
  `/opt/seo-api/shared/.env` and register the matching redirect URI in Google
  Cloud.
- Remediation type: external configuration (and one env value).

**H2. The Vercel `/api` rewrite is a hardcoded plain-HTTP bare IP.**
- Location: `vercel.json:4-6`, `apps/web/vercel.json:4-6`.
- Current behavior: all API traffic is proxied server-side to
  `http://144.172.102.63/api/...` with no TLS, no hostname and no environment
  indirection.
- Consequence: single point of failure; any VPS IP change requires editing and
  redeploying the SPA; behavior for POST bodies and OAuth redirect hops through
  the proxy is unverified.
- Smallest remediation boundary: replace the hardcoded IP with a stable
  hostname (and ideally HTTPS) in the rewrite target.
- Remediation type: configuration/code (small).

### Medium

**M1. GSC production operation is entirely external-config dependent and unverifiable from the repo.**
- Location: `config.ts:48-50`, `providers/gsc/oauth.ts`, `gscApi.ts:34`.
- Current behavior: code is complete; presence of `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, the authorized redirect
  URI and the enabled Search Console API is not observable in the repository.
- Consequence: GSC may be non-operational in production while all code and tests
  pass; only `/api/health` booleans can confirm env presence.
- Smallest remediation boundary: verify the §F checklist in Google Cloud,
  Supabase and the VPS `.env`.
- Remediation type: external configuration.

**M2. The Vercel build command and output are not encoded in the repository.**
- Location: `vercel.json` (rewrites only); `packages/contracts/package.json`;
  `.gitignore:2` ignores `dist/`.
- Current behavior: the web bundle imports runtime values from `@seo/contracts`,
  which points at a gitignored `dist/`. CI builds contracts first; Vercel's
  equivalent ordering is dashboard-side.
- Consequence: the deployed frontend depends on undocumented dashboard settings;
  a settings reset would break the build.
- Smallest remediation boundary: commit an explicit Vercel build command (for
  example `pnpm --filter @seo/contracts build && pnpm --filter @seo/web build`)
  or equivalent config.
- Remediation type: configuration (code-adjacent).

**M3. Production schema state is unverifiable; migrations are not validated in CI.**
- Location: `supabase/migrations/` (000001-000031); `deploy/README.md:158-171`;
  `.github/workflows/ci.yml` (no migration step); `CLAUDE.md` references a
  `dist/supabase-schema.sql` that does not exist in the tree.
- Current behavior: migrations are applied manually and never exercised by CI.
- Consequence: a migration required in code but absent from the hosted project
  would fail only in production; the consolidated snapshot referenced by
  documentation is missing.
- Smallest remediation boundary: add a CI job running
  `scripts/db-migrate-local.sh` against a fresh DB, and either generate the
  consolidated schema artifact or remove the stale reference.
- Remediation type: code/configuration.

**M4. Preview deployments share the production API and database with no environment split.**
- Location: `vercel.json:5`; `apps/api/src/config.ts:30`.
- Current behavior: all Vercel environments proxy to the same VPS API, which uses
  the same hosted Supabase project.
- Consequence: preview testing mutates production data; there is no staging
  boundary.
- Smallest remediation boundary: accept and document, or add a preview-specific
  API/env target.
- Remediation type: external configuration.

### Low

**L1. Documentation inconsistencies that can mislead production work.**
- `CLAUDE.md` states the API is "authenticated as your own user, RLS still
  applies to `auth.uid()`", while the code uses the service-role key which
  bypasses RLS and re-derives membership (`supabase.ts:1-13`, `context.ts:38`).
- `deploy/README.md:50` refers to a `production` environment while
  `deploy.yml:23` uses `Production` (case-sensitive in GitHub).
- `roadmap.md:55-80` describes the deploy foundation as partly pending, while
  the deployment pipeline and Vercel config already exist.
- Consequence: wasted verification effort, not an operational failure.
- Smallest remediation boundary: correct the three references.
- Remediation type: documentation.

**L2. `deploy.yml` deploys on every successful CI run on `main`, including docs-only commits.**
- Location: `.github/workflows/deploy.yml:19-22`.
- Consequence: unnecessary restarts; small availability churn.
- Smallest remediation boundary: add a path filter or an artifact-changed
  condition.
- Remediation type: configuration.

---

## Minimal next-step slices

Grouped into the smallest actionable units, ordered by dependency. No
implementation briefs are written here.

1. **Verify external configuration (no code).** Google Cloud: OAuth client type,
   authorized redirect URI `https://oldskoolseo.com/api/oauth/gsc/callback`,
   consent-screen scope `webmasters.readonly`, Search Console API enabled.
   Supabase: Site URL / redirect allow-list for `https://oldskoolseo.com`; VPS
   `.env`: `PUBLIC_APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `CREDENTIALS_ENCRYPTION_KEY` (confirm presence only, via `/api/health`
   booleans).
2. **Live-verify the Vercel `/api` proxy** with a real authenticated request and
   the OAuth callback hop; confirm POST bodies and redirects traverse the
   rewrite.
3. **Google login slice (code).** Add `signInWithOAuth({ provider: 'google' })`
   with `redirectTo` to `AuthScreen`; configure the Supabase Google provider and
   its Google callback.
4. **Vercel build hygiene.** Encode the `contracts -> web` build order in
   repository-visible configuration; replace the hardcoded VPS IP with a stable
   HTTPS hostname.
5. **CI/schema hygiene.** Add a fresh-DB migration validation job; resolve the
   missing `dist/supabase-schema.sql` reference.
6. **Docs.** Correct L1 references.
7. **GitHub protection (external).** Require PR + the `CI` check on `main`.

---

## Production readiness verdict

**SMALL CONCRETE PRODUCTION GAPS REMAIN**

Reasoning: the deployment foundation (Vercel SPA, VPS API/worker, artifact
deploy, health-checked rollback, CI build/test gate) is confirmed present and
coherent. GSC is code-complete and blocked only by external Google
Cloud/Supabase/VPS configuration, which is explicitly classified as requiring
verification rather than as broken. The one genuine, concrete code gap is that
Google **login** is not implemented at all in `AuthScreen`, which is a small,
bounded addition. Alongside it, the Vercel build command, the plain-HTTP bare-IP
API rewrite, unchecked migrations and the absent branch-protection
configuration are bounded hardening items. None of these require re-architecting
deployment.

---

## Update: Google Analytics integration (P4)

This section supersedes the Google data-source classification above where it
conflicts. Search Console status is unchanged; Analytics was added as a
separate, additive data source.

| Capability | Status |
| --- | --- |
| Google Analytics integration | COMPLETE |
| Basic page traffic intelligence | COMPLETE |
| Google Ads | OUT OF SCOPE |
| Competitor intelligence | OUT OF SCOPE |

- **Google Analytics integration: COMPLETE.** Account-scoped
  `provider_type = 'ga4'` integration reusing the existing Google OAuth client,
  signed state, callback helper and encrypted credential store (`analytics.readonly`
  + `openid` + `email`). GSC row and scope are untouched.
- **Basic page traffic intelligence: COMPLETE.** One GA4 property per project
  (`seo_project_analytics`, migration `20260101000033`), live page-traffic reads
  for 7 / 28 / 90 days, project member read RLS, server-only writes.
- **Google Ads: OUT OF SCOPE.** No Ads API, scope or surface is present.
- **Competitor intelligence: OUT OF SCOPE.** No competitor data path is present.

Production operation still depends on external configuration that cannot be
verified from the repository: enabling the Google Analytics Admin API and Data
API on the existing Cloud project, adding the `analytics.readonly` consent
scope, and authorizing the GA4 redirect URI
`https://<domain>/api/oauth/ga4/callback`. See `docs/google-analytics-setup.md`.
No new environment variables are required.
