# CONTENT STUDIO — GENERAL ARCHITECTURE & ROADMAP

> Status: corrected against the existing repository (2026-09-06). The repo
> already contains a working content engine (`seo_content`, CRUD, API, RLS,
> block editor, deterministic analysis, AI pipeline, publishing). Content
> Studio is an evolution of that system, never a second content system.
> Read `CLAUDE.md` for code-level conventions; this file only records the
> Content Studio architecture and phases.

## PURPOSE

Content Studio is the project-scoped workspace for creating, editing,
optimizing, enriching and publishing content.

It is not an AI article generator and not just a rich-text editor.

The central principle is:

```text
Project
└── Content Studio
    └── Content Document
```

Content Studio is project-scoped. Projects are already independent from GSC,
so Content Studio must continue to work without a linked GSC property. This
is a confirmation of the existing architecture, not a new feature to build.

It must work for:

- SEO projects
- content-only projects
- social media projects
- projects without a website or GSC property

---

# CORE ARCHITECTURE

The Content Document is the central object.

```text
                    CONTENT DOCUMENT
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
      EDITOR            SEO ENGINE        METADATA
        │
        ├───────────────┬──────────────────┐
        ▼               ▼                  ▼
       AI           KNOWLEDGE          PUBLISHING
```

The document remains the source of truth.

AI, knowledge, SEO and publishers work around the document.

They must not create competing versions of the content.

---

# CONTENT MODEL

Content is project-scoped and uses the existing `seo_` table prefix.

The primary entity **already exists and stays**:

```text
seo_content
```

Do **not** create `seo_contents`, do not rename the table, do not run
destructive migrations. The existing `seo_content` table already carries:

- project (`project_id`)
- title, slug (unique per project)
- status
- structured editor document (`content_json`)
- HTML output (`content_html`, derived)
- SEO metadata (`meta_title`, `meta_description`)
- target keyword (`target_keyword`) + `language`
- SEO score (`seo_score`)
- outline (`outline`)
- timestamps, audit, RLS and existing RPCs/relations

Phase A begins explicitly with: *inspect and extend the existing
`seo_content` table.* Existing data, RLS policies, RPCs and relations are
preserved; any change is additive.

---

# SINGLE SOURCE OF TRUTH

The structured document column is the canonical version:

```text
content_json   (JSONB on seo_content)
```

There is **no** second JSON column (no `editor_json`, no parallel document
representation). `content_json` is the single canonical document
representation. Today it holds the current block model; in Phase B the same
column may evolve to hold a Tiptap/ProseMirror document structure:

```text
content_json
    │
    ├── current block model
    └── later: Tiptap document JSON
```

HTML is derived output (`content_html`), never a second source of truth.

Future outputs may include:

```text
content_json
    │
    ├── HTML → WordPress
    ├── Markdown → Export
    ├── Plain Text → Analysis
    ├── X → Short Post
    ├── LinkedIn → Adapted Post
    └── Other Publishing Formats
```

Do not allow editable HTML and editor JSON to become competing sources of
truth.

---

# CONTENT STUDIO WORKSPACE

The editor should conceptually contain three areas:

```text
┌───────────────┬────────────────────────┬──────────────────┐
│ DOCUMENT      │                        │ TOOLS / CONTEXT  │
│               │        EDITOR          │                  │
│ Outline       │        Canvas          │ SEO              │
│ Structure     │                        │ Knowledge        │
│ Sections      │                        │ AI               │
│               │                        │ Publishing       │
└───────────────┴────────────────────────┴──────────────────┘
```

The exact UI may evolve.

On smaller screens the panels may collapse or move.

The architecture is more important than forcing three visible columns
everywhere.

---

# DOCUMENT UTILITIES

Create shared utilities that understand the editor document.

They should eventually support:

- plain text extraction
- heading extraction
- section extraction
- word counting
- introduction detection
- keyword analysis
- HTML generation

These utilities must be reusable by:

- editor
- SEO engine
- AI
- knowledge retrieval
- publishing

Do not duplicate document parsing logic across multiple systems.

---

# SEO ENGINE

SEO analysis is a separate deterministic system.

It evaluates:

```text
Content Document
+
SEO Metadata
+
Keywords
```

and returns:

- score
- checks
- warnings
- suggestions

The score must be explainable.

It represents:

```text
Document optimization completeness
```

It does NOT represent:

```text
Google ranking probability
```

The SEO engine must work without AI, GSC or DataForSEO.

Later it can be enriched with:

- GSC opportunities
- keywords
- DataForSEO
- SERP research

A deterministic content analysis already exists in the repo
(`contentAnalysis`); Phase C builds the full SEO sidebar experience around
it without adding an AI-generated score.

---

# AI ARCHITECTURE

AI is an optional service around the document.

It should eventually receive:

```text
User Request
+
Document Context
+
Project Context
+
Knowledge Context
+
SEO Context
```

Future AI actions may include:

- generate outline
- generate article
- generate section
- rewrite
- improve selection
- expand
- shorten
- change tone

AI providers must remain pluggable.

The editor must not contain provider-specific logic.

Support future:

- managed AI
- BYOK
- multiple providers

AI remains an assistant to the user, not the owner of the document.

AI/BYOK providers and a staged content-agent pipeline already exist in the
repo; Phase D turns them into in-editor document actions.

---

# KNOWLEDGE & QDRANT

Content Studio will eventually use project knowledge.

Possible context sources:

```text
Project Knowledge
Existing Content
Documents
Website Information
Keywords
GSC Opportunities
```

These are retrieved through a knowledge service.

The editor should not call Qdrant directly.

Qdrant is the current vector store, but retrieval should be abstracted
through the application service layer.

Embeddings are infrastructure and should also remain provider-based.

Initial embedding provider can be OpenAI.

Knowledge providers and Qdrant retrieval already exist behind an interface;
Phase E wires them into Content Studio as context, not as a new subsystem.

---

# MEDIA

Media must be pluggable.

Future providers may include:

- uploads
- WordPress Media
- Pexels
- Unsplash
- AI image generation

Content Studio should not depend on one media provider.

Media is a later phase.

---

# PUBLISHING

Publishing is an output layer.

```text
CONTENT DOCUMENT
       │
       ▼
CONTENT TRANSFORMER
       │
       ├── WordPress
       ├── X
       ├── LinkedIn
       ├── Facebook
       ├── Instagram
       └── TikTok
```

Publishers must be pluggable.

The original document remains independent from publishing providers.

One document may eventually produce different output for different channels.

Publication status must eventually be separate from the document lifecycle.

For example:

```text
Article
├── WordPress → Published
├── LinkedIn → Scheduled
├── X → Published
└── Instagram → Not Published
```

The existing publishing layer (`seo_publishers`, `seo_publications`,
WordPress) stays; Phase G expands provider coverage.

---

# SECURITY

Content belongs to a project.

Existing project membership, Supabase RLS and account isolation must remain
in control.

Users must never access:

- another project's content
- another project's knowledge
- another user's AI credentials
- another account's publishing integrations

Content Studio must use the account/project architecture already established.

Do not redesign tenancy during Content Studio development.

---

# ROADMAP

Each phase is independently scoped, implemented, tested and approved.
Nothing is built silently; the current phase is always finished and reviewed
before the next begins.

## Phase A — Content Foundation

We already have the content engine. Phase A is about turning the existing
content system into the proper Content Studio foundation, not replacing it.

1. **Inspect** the existing `seo_content` architecture (schema, RLS, RPCs,
   relations, API routes, current web views).
2. **Preserve** existing data, APIs, RLS and relations. Never create
   `seo_contents`, rename the table, or run destructive migrations.
3. **Identify** the missing Content Studio capabilities (gaps between the
   current system and the model above).
4. **Extend** the existing content system non-destructively (additive schema
   only).
5. **Build/complete** the Content Studio overview and draft workflow
   (create/open/delete drafts, content overview).
6. No editor rewrite yet beyond what is needed for solid content records.

## Phase B — Editor Foundation

- Tiptap / ProseMirror as the editor foundation, stored in the existing
  `content_json` column (same JSONB column; it evolves from the block model
  to a Tiptap document structure — no second JSON column).
- autosave, save state
- document outline
- shared document utilities
- HTML output derived from `content_json`

## Phase C — SEO Engine

- SEO metadata editing
- deterministic checks (extend existing `contentAnalysis`)
- explainable score
- keyword analysis
- SEO sidebar
- No AI-generated SEO score.

## Phase D — AI

- OpenAI integration
- BYOK
- provider abstraction
- selection actions
- section generation
- outline/article generation
- Wired as in-editor document actions on top of the existing AI pipeline.

## Phase E — Knowledge

- embedding service
- Qdrant integration
- project context retrieval
- related content
- future internal link suggestions

## Phase F — Media

- media abstraction
- media blocks
- uploads
- image providers

## Phase G — Publishing

Expand publishing through pluggable providers:

- WordPress
- X
- LinkedIn
- Facebook
- Instagram
- TikTok

## Content Studio H-series

Delivered in order, each phase independently approved:

- H1 - schedules with exactly one backing publish job per schedule
- H2 - calendar UI + schedule management
- H3 - publication history + delivery visibility
- H4 - MCP scheduling/publication tools (thin layer over existing services)
- H5 - capability-aware social publishing foundation: registry-driven publisher
  metadata (setup/category), canonical capability tokens with legacy
  normalization, env-gated mock social provider, safe PublisherError vocabulary

## Phase H6 - X publishing adapter (roadmap)

Keep H6 small and sharp: one real provider end-to-end on top of the H5
foundation. No social-dashboard explosion.

Goal: a user can connect an X account, publish or schedule a text post from a
project, and see the real publication history/results.

Architecture stays as-is:

```text
Content -> publisher capability gate -> X Publisher Adapter -> X API
         -> publication/schedule/job history
```

Scope (H6 only): publish_text and schedule. Not yet: publish_image,
publish_video, thread publishing, reply publishing, analytics.

Provider registry: add a real `x` provider to the existing publisher registry,
reusing the H5 registry-driven config/credential architecture. No hardcoded X
form in React.

Authentication: implement the current X API auth method for posting on behalf
of a user. Credentials stay server-side only, in the existing encrypted
credential storage; never to the frontend, never in logs. Map token/API
failures to the existing safe PublisherError codes (401 ->
publisher_auth_failed, 429 -> publisher_rate_limited, 403 ->
publisher_rejected_content / forbidden, 5xx/network -> provider error). No new
credential vault; reuse seo_publishers + seo_credentials and the existing
publisher credential flows.

X adapter: a separate adapter (e.g. publishers/xPublisher.ts) implementing the
same provider interface as WordPress and mock_social. Responsibilities:
validate credentials, build X payload, publish text, parse response, return a
normalized publication result, map provider errors. The adapter does no direct
database writes; the existing publishing service/job executor stays responsible
for publication records, job status, schedule linkage, history and retries.

Payload: reuse buildSocialTextPost with an X-specific adapter layer: canonical
social post -> X payload builder -> character validation -> X API payload.
Plain text, optional URL, never HTML. Respect the current X character/content
limits; on overflow return publisher_rejected_content with a safe message. No
automatic truncation without an explicit product decision.

Publisher setup UI: minimal extension of the existing Publishing UI. A user can
add an X publisher, enter provider credentials/config via registry metadata,
and see connection status + capabilities. No social composer; no OAuth wizard
unless the chosen X auth method requires it (if OAuth is needed, implement it
as a clean provider flow, not as X-specific logic in generic routes).

Publishing: content -> publisherCanPublishContent -> buildSocialTextPost -> X
adapter -> X API -> normalized result (remote_id, target_url when reliably
derivable, published_at). Store no more than needed; reuse seo_publications,
PublicationService and publication history.

Scheduling: H1/H2/H4 keep working unchanged. A scheduled X publication flows
seo_schedules -> seo_sync_jobs -> existing worker -> publish executor -> X
adapter. No second scheduler; no provider-specific scheduling code outside the
adapter/executor flow; one schedule -> one backing job.

MCP: no new X-specific MCP tools. The existing schedule_create/list/reschedule/
cancel and publication_list/get tools work automatically once X is a normal
publisher. If generic publisher capability validation is missing anywhere, fix
it generically.

Error handling: use the H5 vocabulary. Minimally test invalid credentials,
expired credentials, 403 forbidden, 429 rate limit, network failure, provider
5xx, invalid/too-long content, and malformed provider responses. All errors
must be safe for the API, worker, publication history, UI and MCP - no secrets,
tokens or raw authorization headers.

UI gating: treat X as a normal social publisher and show only what it supports.
WordPress shows publish article/update/delete; X shows publish text/schedule. An
X publisher must never accidentally receive a WordPress article form or an
unsupported action.

Testing:

- adapter: successful publish, credential validation, payload conversion,
  length validation, remote id parsing, URL extraction
- errors: 401, 403, 429, 5xx, network timeout, malformed response
- integration: direct publish, scheduled publish, publication history,
  capability rejection, wrong project isolation
- regression: WordPress unchanged, mock_social unchanged, schedule flow
  unchanged, publication history unchanged, MCP generic schedule flow unchanged

Definition of done:

- a real `x` provider exists in the registry
- credentials are stored encrypted
- X text can be published
- the existing social text builder is reused
- publication history shows real metadata
- scheduling works through the existing H1 job flow
- capability gating works
- safe error mapping works
- no secrets leak to the frontend or logs
- WordPress regression test green
- mock provider keeps working
- API tests green; contracts build green; API build/typecheck green;
  web build/typecheck green

STOP after H6. No images, video, threads, replies, analytics, X-specific MCP
tools, social composer redesign, or LinkedIn/Facebook/Instagram/TikTok.

---

# DEVELOPMENT RULE

Each phase must be independently scoped, implemented, tested and approved.

Do not silently begin future phases.

The priority is:

```text
Stable Content Model
        ↓
Reliable Editor
        ↓
Deterministic SEO
        ↓
AI
        ↓
Knowledge
        ↓
Media
        ↓
Publishing
```

The Content Document remains central throughout the entire architecture.
