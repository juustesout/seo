# CLAUDE.md

Instructions for an AI coding agent working in this repository. Read this
first. It overrides generic habits; when in doubt, follow `roadmap.md` for
direction and this file for rules.

## Project

Modular, project-scoped **SEO operating platform** (pnpm monorepo):

- `packages/contracts` — shared provider/registry/DTO contracts
  (`@seo/contracts`, pure types, builds with `tsc`).
- `apps/api` — Express API (`@seo/api`) + durable background **worker**. Talks
  to Supabase with the service-role key (server only), runs providers, hosts
  routes under `/api`.
- `apps/web` — React + Vite UI (`@seo/web`). Never holds provider credentials.
  Only knows Supabase anon keys; dev proxy sends `/api` to the API on :3001.
- `supabase/migrations` — schema + RLS + RPCs. Tables use the `seo_` prefix.
- `scripts/db-migrate-local.sh` — validates migrations + smoke tests against a
  **fresh** local Postgres database (run as root, name must not be reused).
- `dist/supabase-schema.sql` — consolidated migrations for manual paste into
  the hosted Supabase SQL editor.

## Commands

```bash
pnpm install                         # link workspace deps
pnpm --filter @seo/contracts build   # must pass before API typecheck
pnpm --filter @seo/api typecheck     # tsc --noEmit
pnpm --filter @seo/api build         # emits dist (API + worker)
pnpm --filter @seo/web typecheck     # tsc --noEmit
pnpm --filter @seo/web build         # production build
```

Run services (env is loaded from `apps/api/.env` with `node --env-file`):

```bash
node --env-file=apps/api/.env apps/api/dist/index.js   # API, :3001
node --env-file=apps/api/.env apps/api/dist/worker.js   # job worker
MCP_API_KEY=seo_live_... node --env-file=apps/api/.env apps/api/dist/mcp/index.js   # MCP (stdio), bound to a project API key
pnpm --filter @seo/web dev                              # Vite, :5173, /api -> :3001
```

Tests run with vitest inside `apps/api` (`pnpm --filter @seo/api test`).

## Architecture invariants (do not break these)

1. **One brain, two mouths.** REST routes and the future MCP server both call
   the same SEO Core services. MCP must never read Postgres or call providers
   directly. New business logic lives in services, not in route handlers.
2. **Project-scoped everything.** Every capability, job, credential, content
   item, knowledge entry and future API/MCP call resolves under a project.
   Route shape: `/api/projects/:projectId/...`. Authorize every project-scoped
   operation with `container.access.requireRole(user.sub, projectId, role)`.
3. **Providers via interfaces, UI via capabilities.** Consumers depend on the
   `@seo/contracts` interfaces (`SeoDataSource`, `KnowledgeProvider`,
   `PublisherProvider`, future `AIProvider`/`MediaProvider`). The web UI
   discovers providers through the catalog endpoint and never hardcodes a
   provider id or vendor. Adding a provider = register adapter + descriptor;
   no UI change required.
4. **RLS is the boundary.** All Supabase access from the API uses the
   service-role client (authenticated as your own user, RLS still applies to
   `auth.uid()`), and every new table is `seo_*` with row-level policies plus
   a smoke-test addition. Never bypass RLS; never ship the service key to the
   frontend.
5. **Secrets.** Only gitignored `*.env` files (`apps/api/.env`,
   `apps/web/.env`, and the untracked `keys.env` / `github_pat.env`).
   - Never log, print, echo or commit secret values. Never display them in
     chat responses.
   - Stored provider credentials are encrypted with AES-256
     (`CREDENTIALS_ENCRYPTION_KEY`) in `seo_credentials`.
   - BYOK: user AI/embedding keys must be read from project-scoped env names
     oriented at the user (e.g. `USER_LLM_API_KEY`, `USER_EMBEDDINGS_API_KEY`),
     never from agent-runtime variables and never hardcoded. Browser never sees
     them.
6. **Honesty rule.** No invented or fabricated metrics. A capability that is
   not configured is reported as "not configured". Provider failures surface
   as errors on the job/connection, not silent zeros.
7. **Long operations are jobs.** Slow provider work goes through
   `container.jobStore.enqueue(...)` and runs in the worker. HTTP handlers
   must not block on provider calls that take more than a moment.
8. **Qdrant isolation.** Each project uses its own collection(s). Searches and
   indexing never cross project boundaries.
9. **Validate input, typed output.** Validate request bodies with zod at the
   route edge; return `{ data }` on success and `{ error: { code, message,
   details } }` on failure via the shared error handler.

## Conventions

- Do not add code comments unless they explain *why* something non-obvious is
  the way it is.
- Follow existing naming and structure (routes in
  `apps/api/src/http/routes`, provider in
  `apps/api/src/providers/<name>/`, jobs in `apps/api/src/jobs/executors.ts`,
  migrations ordered with `YYYYMMDDNNNNNN_*.sql`).
- API packages use NodeNext `.js` import specifiers in TS source.
- No emojis in code or docs.

## Content model direction

Structured content is the source of truth; HTML is a render. When working on
content, prefer extending `seo_content` with fields like `outline`,
`content_json` (blocks), `target_keyword`, `meta_title`, `meta_description`,
`seo_score`, `content_html` — do not treat a raw HTML blob as the only
representation.

## Definition of done for a change

1. `pnpm --filter @seo/contracts build` passes if contracts changed.
2. Touched packages typecheck (`@seo/api` then `@seo/web`), and API tests pass
   when the area is covered.
3. Schema changes: add a numbered migration under `supabase/migrations/` with
   RLS policies, and extend `scripts/db-migrate-local.sh` smoke checks.
   Validate against a **fresh** DB name. Never run destructive SQL against the
   shared hosted project.
4. No secrets added, printed, or committed.
5. No fabricated data paths; new provider adapters implement their real
   capability or declare themselves not configured.
6. Commit only when the user asks. If a secret file would be caught by `git
   add -A`, the ignore rules in `.gitignore` are wrong — fix them first.
