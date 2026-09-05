# Roadmap — Modular SEO Operating Platform

This is the general plan for `juustesout/seo`. It records where we are, the
architecture we are committing to, and the ordered milestones we intend to
build. The single source of truth for code-level conventions is `CLAUDE.md`.

## 1. North star

Turn the repo into an **agent-accessible, project-scoped SEO operating
platform**:

> "For project X, research keyword Y, analyse the SERP, draw on our knowledge
> base, write a ~2,000 word article with relevant images, stage it in the
> editor, and publish only after I approve."

That sentence is *not* a special chatbot feature. It is: **MCP → SEO
Application layer → providers**. The web app is another mouth on the same
brain.

## 2. Architecture we are committing to

```
                        SEO PLATFORM
                             │
            ┌────────────────┼────────────────┐
            │                │                │
         WEB APP           REST API          MCP
            │                │                │
            └────────────────┼────────────────┘
                             │
                        SEO CORE
                        (one brain)
                             │
      ┌──────────────┬───────┼────────┬──────────────┐
      │              │       │        │              │
  Data Sources   Content   Knowledge Publishing   Agents
      │              │       │        │          (BYOK)
  DataForSEO      Editor   Qdrant   WordPress
  GSC             Agent             X / LinkedIn /
  Crawler                             Facebook / IG /
                                      TikTok (later)
                             │
                        SUPABASE
```

Two hard consequences of this picture:

1. **REST API and MCP are both thin layers on top of the same SEO Core
   services.** MCP must never talk straight to Postgres or DataForSEO. One
   brain, two mouths.
2. **Everything is project-scoped.** The user picks a project and it becomes
   the context for keywords, pages, GSC, DataForSEO, Qdrant, content,
   publishing, AI keys, API keys and MCP resources.

## 3. What is real today (verified)

| Area | State |
| --- | --- |
| Monorepo | `@seo/contracts`, `@seo/api`, `@seo/web` (pnpm workspaces) |
| Database | All `seo_*` tables + RLS + RPCs applied to hosted Supabase; validated against local Postgres via `scripts/db-migrate-local.sh` |
| Projects | `seo_projects` + membership roles (owner/admin/editor/viewer), project selector in UI, project-scoped routes |
| Content | Structured `seo_content` (blocks source of truth + HTML render, metadata, keyword, statuses, `seo_score`), block studio, staged content agent (brief/outline/article) into drafts, deterministic SEO audit with optional AI pass |
| REST v1 | `/api/v1/projects/:projectId/content` (+ analysis) behind project-scoped, SHA-256-hashed, revocable API keys with `read`/`write` scopes; shares the SEO Core services |
| MCP | Stdio MCP server bound to a project API key (read/write scopes); tools `content_list/get/analyze`, `jobs_list`, `content_generate`, `content_resolve_images`, `content_update`; publish/archive demand explicit `confirm`, delete is not exposed; no direct Postgres/provider access |
| DataForSEO | Working adapter; live keyword research + SERP retrieval through background jobs (verified end-to-end) |
| GSC | OAuth flow + property attach implemented; needs Google OAuth env + public URL to activate |
| Qdrant | Knowledge provider with per-project isolated collections; blocked on embedding key |
| WordPress | Basic publisher (draft/publish/update/delete) implemented; publish jobs run through the worker and publication rows stay honest on failure (`failed`/`queued` + message) |
| Jobs | Durable `seo_sync_jobs`, worker with retry/backoff/cancel, unknown job types fail loudly, stale `running` jobs are swept, no long ops in HTTP handlers |
| Web | Capability-driven React UI (dashboard, keywords/rankings, integrations, knowledge, publishing, content studio) |

## 4. Milestones (proposed order)

> "Deploy foundation first, and MCP *before* social publishers."

### ① Deploy foundation
- Web app on Vercel, production Supabase project, linked domain.
- Production env vars, production OAuth redirect URLs for Google.
- CI: typecheck + build + (optional) migration lint.
- **Done when:** preview is replaced by a real URL and GSC connect works from prod.

### ② Projects as first-class context
- Tighten project model: every capability, job, credential, AI key, API key
  and MCP resource resolves under `/projects/[projectId]/…`.
- Project context endpoint (GSC properties, keywords, pages, integrations,
  knowledge, current feature state) usable by UI, API and MCP alike.
- Role-gating reviewed per surface (viewer/editor/admin/owner).
- **Done when:** a new collaborator can be added to one project without
  touching another project's data.

### ③ AI / BYOK layer (blocks Content Agent and embeddings)
- `AIProvider` interface (`id`, `models()`, `chat(...)`, `embed(...)`) with an
  OpenAI provider first (Anthropic/Google/OpenRouter can follow behind the
  same interface).
- `EmbeddingProvider` behind the same AI abstraction → feeds Qdrant; start
  with OpenAI embeddings.
- User-owned keys configured **server-side per project/account**; never stored
  or used in the browser.
- **Done when:** a project can set its own OpenAI key + model + embedding
  model in the UI and the server uses them.

### ④ Content Studio / editor
- Structured content model (extend `seo_content`): title, slug, status,
  target keyword, secondary keywords, search intent, meta title/description,
  outline, `content_html` (render) + `content_json` (source of truth blocks),
  `seo_score`, timestamps.
- Proper editor UI with SEO side panel (suggested title/meta/slug, word count,
  recommendations) and AI actions wired to the AI layer.
- Media attachments (see MediaProvider below).
- **Done when:** content is edited as blocks, rendered to HTML, and carries
  live SEO metadata.

### ⑤ Content Agent
- Agent that uses **project context**: GSC performance, DataForSEO keywords,
  Qdrant knowledge, existing pages, competitor/SERP data.
- Pipeline: request → project context → content brief → outline → article →
  SEO validation → staged in editor (never auto-publish).
- Should be able to propose title/meta fixes from CTR data, not just "write
  an article".
- **Done when:** the north-star sentence works from the editor for one
  project, and every provider call is a real one.

### ⑥ REST API v1
- Versioned `/api/v1/...`, project-scoped, auth via JWT and external API keys.
- OpenAPI documentation as part of the repo.
- **Done when:** an external application can drive a project's SEO features
  without the web UI.

### ⑦ MCP server
- MCP server on the **same SEO Core services** as REST (no direct DB/provider
  access).
- Project-aware **tools**: `list_projects`, `get_project_context`,
  `search_keywords`, `get_rankings`, `get_serp`, `get_gsc_performance`,
  `search_project_knowledge`, `index_project_content`,
  `create_content_brief`, `generate_article`, `analyze_article`,
  `get_publishers`, `publish_content`.
- Project-aware **resources**: `project://<id>`, `project://<id>/keywords`,
  `project://<id>/pages/<id>`, …
- **Done when:** Claude/ChatGPT-style client can drive the full content flow
  for an authorized project.

### ⑧ WordPress polish
- Draft/publish/update parity, publication tracking, statuses surfaced in UI.
- **Done when:** content staged in the editor can be published/updated with
  clear state and retries.

### ⑨ Social publishers (deliberately later)
- Keep the `Publisher` abstraction; register X, LinkedIn, Facebook, Instagram,
  TikTok as capability-only stubs.
- No UI/deep work until the platform is agent-complete.
- **Done when:** each social channel is represented by an adapter descriptor
  (auth type, capabilities) without fake implementations.

## 5. Cross-cutting concerns

- **MediaProvider** interface (`search`, `generate`, `upload`) so the Content
  Agent can source images without hardcoding a vendor. Start with one real
  provider.
- **Secrets**: only gitignored `*.env` files; AES-256 encryption at rest for
  stored credentials; nothing secret ever in the browser or in logs.
- **Honesty rule**: provider adapters and jobs report real state. A capability
  that is not configured is displayed as "not configured", never simulated.
- **RLS rule**: Supabase RLS stays the boundary; the service role key exists
  only server-side. All new tables are `seo_*` with policies + a smoke check.
- **Background work**: anything slow is a durable job executed by the worker.

## 6. Phase 2 (next working session)

Scope for the next phase, in order:
1. AI/BYOK abstraction + OpenAI provider (chat + embeddings).
2. Content Studio: structured content + editor + SEO panel.
3. Content Agent (project-context pipeline) that produces editor-ready content.
4. Deploy foundation (Vercel + domain) so GSC and production OAuth work.

Not in phase 2: social publishers, MCP (milestone ⑦) and REST v1 (⑥) are
queued after the agent/editor foundations unless priorities shift.

## 7. Non-goals (for now)

- Building all social posters before the platform is agent-complete.
- Multiple AI vendors beyond OpenAI until the abstraction is proven.
- A crawl/audit engine (no crawler provider registered; feature stays honest).
