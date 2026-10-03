# Architecture & Product Debt Recon (Pre-P5)

Recon-only. No production code, contracts, migrations, routes, auth, RLS, retry
or provider behavior was changed. The only artifact is this document.

- **Baseline commit:** `fe3e2e2` (`chore(quality): enforce lint, CI, coverage and
  strict indexing`), `origin/main`.
- **Method:** current repository is the source of truth. Historical docs
  (`production-readiness-recon.md`, `production-administration-recon.md`,
  `codebase-security-audit.md`, `p1-hardening-recon.md`, the `r5.*` set, the
  Google Analytics/login docs) were treated as claims to be checked against code.

---

## 1. Current architecture map

```text
Browser (React + Vite, apps/web)
   |  Supabase Auth session (anon key only); no provider credentials
   |  /api/* via dev proxy / Vercel rewrite -> https://api.peerdisco.com
   v
Express API (apps/api/src/app.ts)
   |-- public:  GET /api/health (liveness), GET /api/ready (DB), /api/oauth/*
   |-- identity/account:  /api/me, /api/account (+ /ai, /api-keys, /usage)
   |-- platform admin:    /api/admin
   |-- project-scoped:    /api/projects/:projectId/{integrations,publishers,
   |                       publications,schedules,knowledge,ai,cosmos,
   |                       composition,content,designer,media,jobs,keyword,
   |                       api-keys,gsc,analytics,usage}
   |-- agent REST v1:     /api/v1  (API-key auth)
   |-- MCP:               /api/mcp (HTTP) and stdio (mcp/index.ts)
   v
SEO Core services (apps/api/src/services/*)  <-- one brain, two mouths
   |  REST routes and MCP both call these (with two documented exceptions)
   v
Providers (apps/api/src/providers/*) via @seo/contracts interfaces
   |-- dataforseo, gsc, qdrant+embeddings, jina, rerank(cohere, opt-in),
   |   ai(openai), media(openai/unsplash), publishing(wordpress, x, mock_social)
   |-- ga4: real client + service, but NOT registered in the provider registry
   v
External: DataForSEO | Google (GSC/GA4) | Qdrant | OpenAI | Unsplash | Jina |
          Cohere | WordPress | X
   v
Supabase/Postgres (system of record, RLS); service-role client on the server
   v
Worker (apps/api/src/worker.ts) + durable seo_sync_jobs queue; LISTEN/NOTIFY
or 5s poll; shared retry/circuit-breaker
```

Differences from the conceptual structure in the brief:

- The brief's `Vercel / web -> API` is real but the API is reached through
  Cloudflare (Full strict) to the VPS nginx, not only Vercel serverless
  (`apps/web/vercel.json`, `docs/codebase-security-audit.md:219-221`).
- `worker/jobs` is not below Supabase in the call direction: jobs are persisted
  **in** Postgres and the worker is a sibling process that claims them.
- GA4 breaks the "Providers via interfaces / UI via capabilities" invariant: it
  has no `ProviderDescriptor`, no catalog entry and no registry registration
  (`providers/registry.ts:198-217` only knows `gsc`/`dataforseo`).

---

## 2. R5 unified workspace reality check

The unified workspace is genuinely implemented. There is exactly one owner for
each document concern; the only duplicate is a distribution seam that no
production file reads.

| Concern | Canonical owner (file:line) | Duplicate/shadow owner | Active? | Verdict |
| --- | --- | --- | --- | --- |
| Document identity | `useDocumentSession` state `apps/web/src/components/content/session/useDocumentSession.ts:139`, single instantiation `workspace/workspaceSession.tsx:126` | `DocumentSessionContext` re-export `session/documentSessionContext.tsx:42` | Provider mounted `workspace/ProjectWorkspaceShell.tsx:99`; **no production reader** | Harmless vestigial distribution, not a second identity |
| Document lifecycle | pure projection `session/useDocumentSession.ts:64-78` over `session/useDocumentLoad.ts:39`; surfaced `workspaceSession.tsx:145`, rendered `views/EditorView.tsx:342` | `EditorContextProvider ready` `workspace/EditorMode.tsx:141` (derived) | yes | Derivation, not ownership |
| Revision | `documentRevisionOf` `session/documentRevision.ts:27`; `workspaceRevisionOf` `:62` | `EditorDocumentSnapshot.revision` `editor/editorContext.ts:140` (copy) | yes | One token family; no second scheme |
| Dirty state | `useAutosave.dirty` `session/useAutosave.ts:146`; `workspaceSession.tsx:234` | `EditorDocumentSnapshot.dirty` `editor/editorContext.ts:141` (copy) | yes | Copy only |
| Save | `commit` `workspaceSession.tsx:162-190`, `saveNow` `useAutosave.ts:131`, button `workspace/WorkspaceChrome.tsx:98` | none | yes | One persist path |
| Autosave | one `useAutosave` call `workspaceSession.tsx:192-199` | test mocks only | yes | One mechanism |
| Selection | `EditorSelectionContext` `editor/EditorSelectionContext.tsx:48`, mounted once `EditorMode.tsx:137` | `EditorShell` local fallback `editor/EditorShell.tsx:30-39` only when no provider | fallback inert in workspace | Not a second boundary |
| Undo/redo | Tiptap instance history remounted by `writing.editorKey = session.boundary` (`EditorView.tsx:542`, `EditorWorkspace.tsx:118`) | `editorHistoryKey` `useDocumentSession.ts:120-122` (tests only) | tests only | Same epoch |
| Workspace state | `WorkspaceStateProvider` `workspace/workspaceState.tsx:13`, keyed `ProjectWorkspaceShell.tsx:100` | none | yes | One owner |
| Project context | `useWorkspaceSession.projectId` `workspaceSession.tsx:107,319` + route/`me` in `App.tsx` | none | yes | No shadow object |
| Content context | `EditorContext` `editor/EditorContext.tsx:75`; snapshot builder `editor/editorContext.ts:114` | `EditorContextProvider` props fed from session `EditorMode.tsx:138-144` | yes | Props are the documented low-level API |
| Loading/error | lifecycle (above); load retry `useDocumentLoad.ts:74`; save error `useAutosave.ts:35` | none | yes | Deliberately separated |

Duplicate/shadow detail:

- **`DocumentSessionContext` is mounted but unread in production**
  (`documentSessionContext.tsx:42`; consumers are tests and the barrel
  `session/index.ts:16-21`). Real consumers use `useWorkspaceSessionContext`
  (`EditorView.tsx:108`, `EditorMode.tsx:73`, `WorkspaceChrome.tsx:79`,
  `ComposerMode.tsx:80`, `DesignerMode.tsx:60`, `CompositionApplyBridge.tsx:152`).
  This is harmless compatibility code, but the R5.2.2 doc still describes it as
  the production read seam (`docs/r5.2.2-session-context.md:42-48`) — stale.
- `editorHistoryKey` is a test-only key constructor; production keys the editor
  with `session.boundary` directly.
- **Live behavioral nuance (deferred, minor):** selection is cleared on
  `documentId` change, not `boundary` (`EditorSelectionContext.tsx:56-58`), so
  first-save id adoption clears selection once. Recorded as R5.11 H10
  (`docs/r5.11-hardening-recon.md:105,215-216`); self-healing.

No `TODO`/`FIXME`/`HACK` markers exist anywhere in web source.

---

## 3. Composer / Designer / Editor / Preview audit

| Mode | Entry point | Owner | Consumes | Mutation path | Canonical doc? | Legacy path | Shadow state | Old impl reachable | Duplicate? | Deferred | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Composer | `/p/:id/workspace/composer` via `WorkspaceModeSwitcher.tsx:20,85` | `workspace/ComposerMode.tsx:72` + `views/Compose.tsx:86` | session context + run-local UI (`Compose.tsx:141-161`) | handoff only: `POST /content` then open editor (`Compose.tsx:242-255`), apply/append via `CompositionApplyBridge` (`:211-215,201-204`) | Indirect (preview becomes canonical on handoff) | Retired; `/compose` redirects (`App.tsx:197-207,458`); `views/Content.tsx` deleted | No document shadow; transient `createdIdRef` `Compose.tsx:157` | No | No | `popstate` can change mode past review hold | **COMPLETE** |
| Designer | `/p/:id/workspace/designer` | `workspace/DesignerMode.tsx:59` + `views/Designer.tsx:103` | session `doc/session/lifecycle` + `useDesignerRun` (`Designer.tsx:116`) | shell `applyDesignerProposal` -> bridge (revision/boundary guarded) `Designer.tsx:183-192`, `ProjectWorkspaceShell.tsx:366-394` | Yes, read-only with revision binding | UI retired; server `POST /designer/execute|intent|apply` retained for MCP (`routes/designer.ts:195,225,318`; `mcp/server.ts:680`) | No | UI no; API/MCP yes by design | `useDesignerRun` wraps shared controller; no duplicate | DesignPackage runtime; idempotency; popstate hold | **COMPLETE (UI) + INTENTIONAL LEGACY (server API)** |
| Editor | `/p/:id/workspace/editor[/:contentId]` default | `workspace/EditorMode.tsx:57` -> `views/EditorView.tsx:92` -> `workspace/EditorWorkspace.tsx:75` | full session + selection | Tiptap -> `onDocChange` -> `setDoc` -> autosave (`EditorView.tsx:531-555`); AI review-before-apply | Yes (`content_json` TipDoc) | Retired; `content` view redirects (`projectRoute.ts:119`) | No (`seededKey` is one-shot) | No | Only G5 unused toolbar default + `ContentEditorHeader` alias | H10 selection key; no last-opened by design | **COMPLETE** |
| Preview | shell header toggle (`ProjectWorkspaceShell.tsx:150,422-438`) | `workspace/PreviewPane.tsx:60` | live `doc` + `previewViewport` | none (read-only `CanonicalRenderer` into `sandbox=""` srcdoc) | Yes | None | No | N/A | Reuses the one renderer | fonts in-frame; static `react-dom/server` bundle | **COMPLETE** |

Cross-cutting gap: browser back/forward inside the workspace changes mode and
bypasses the Composer/Designer review hold (`lib/historyNavigation.ts:99-102`
calls `setRoute` directly instead of `requestMode`; `ProjectWorkspaceShell.tsx:219-234`).
Recorded in `docs/r5.4.7` and `docs/r5.6.5`; still present. The save barrier
itself is covered (`historyNavigation.ts:65-113`).

Retirement claims verified: `views/Content.tsx` absent; `Compose` imported only
by `ComposerMode.tsx:38`; `showHeader` absent; `/p/:id/designer` redirects
(`projectRoute.ts:122-124`); DesignPackage has zero runtime references.

---

## 4. Deferred-decision review

| Deferred item | Evidence | Classification |
| --- | --- | --- |
| Browser `popstate` bypasses the Composer/Designer review hold | `lib/historyNavigation.ts:99-102`, `ProjectWorkspaceShell.tsx:219-234` | **STILL RELEVANT** (real, small) |
| Bookmark/reconnect policy (workspace resume) | no last-opened persistence by design (`docs/r5.6.1`) | **STILL VALID BUT LATER** |
| Idempotency keys for designer/bookmark reconnect | `docs/r5.11.2-publishing-idempotency.md`; publishing dedup exists (`publications.ts:240`, `executors.ts:818-837`), workspace-level not | **STILL VALID BUT LATER** |
| DesignPackage runtime functionality | portable contract, zero runtime refs (`docs/r5.5.5` §5-6) | **STILL VALID BUT LATER** |
| Legacy MCP API retirement | MCP HTTP + stdio both live; REST `/api/v1` agent surface still mounted (`app.ts:225`) | **STILL RELEVANT** (now clearly an agent API, not legacy) |
| Selection-clear boundary / H10 | `EditorSelectionContext.tsx:56-58` | **STILL VALID BUT LATER** (transient) |
| R5.11 H4 (`useAsync` retains prior project data) | already fixed: `lib/ui.tsx:50-56` clears data on deps change | **ALREADY SOLVED INCIDENTALLY** |
| R5.11 H1/H2 (popstate, unload guard) | addressed by R5.11.1: `App.tsx:149-155`, `workspaceSession.tsx:207,220` | **ALREADY SOLVED INCIDENTALLY** |

---

## 5. API architecture audit

Report only.

### Route duplication

- Two parallel content surfaces: session routes
  (`routes/content.ts:204,230,244,257`) and API-key `/api/v1`
  (`routes/v1.ts:111,125,133,153,171,178`), mounted `app.ts:225`. Both delegate
  to the same services, so behavior is duplicated at the edge and can drift.
  `/api/v1` has no web consumer (only a docs string in
  `web/views/AccountApiKeys.tsx:268`) — it is intentionally agent-facing.
- Naming inconsistency: `content.ts` mixes `/:id/analysis` (noun) and
  `/:id/analyze` (verb); `/:id/ai` and `/:id/ai/edit`.
- Two GSC attach routes are wired and write the same tables: legacy
  `/integrations/:id/gsc/attach` and new `/gsc/attach` (`app.ts:182,222`).
- Four keyword routers mount on the same base path
  (`app.ts:217-220`) — intentional sub-routing, not duplication.

### Business/DB logic in routes

Direct Supabase `.from(` calls in route handlers (violating the "logic lives in
services" invariant `CLAUDE.md`): `seo.ts:13`, `projectGsc.ts:14`,
`integrations.ts:16`, `account.ts:13`, `publications.ts:8`, `publishers.ts:7`,
`oauth.ts:4`, `me.ts:4`, `projectAnalytics.ts:1`, `jobs.ts:1`. Worst offenders:
`publications.ts:100-206` (insert + idempotency identity + enqueue inline),
`knowledge.ts` (556 lines), `integrations.ts` (445), `account.ts` (426),
`projectGsc.ts` (341). Contrast with well-factored `opportunityService`,
`scheduleService`.

### Error handling

- `oauth.ts` header (`:18-20`) promises "always redirect ... instead of a thrown
  4xx JSON body", but handlers `throw ApiError` (`:57,64,72,86,89,139,146,154,156,167`)
  and `exchangeCode` can throw raw provider errors, so those become JSON via
  `errorHandler`. Doc/behavior mismatch.
- Raw `new ApiError(500, ...)` bypassing the `apiErrors.ts` factories in
  `account.ts:49,89,197,346`, `projectGsc.ts:39,57,207,328`,
  `projectAnalytics.ts:36`, `writer.ts:143-312`.
- Provider errors are not mapped to the API taxonomy at the HTTP edge:
  `gscApi.ts:111` throws raw `Error` (becomes `internal_error` 500);
  `DataForSeoError`/`WordPressError`/`PublisherError`/`KnowledgeIngestError`
  carry status/retryable metadata that is discarded.
- Duplicate `UnauthorizedError` classes: `providers/ga4/googleAnalyticsClient.ts:30`
  and `providers/gsc/gscApi.ts:43`.
- `request_id` is emitted by the API (`apiErrors.ts`) but absent from the
  contract (`packages/contracts/src/api.ts:33,27,42`) and never read by web.
- `requireConfigured` (`http/middleware.ts:94`) is unused; reimplemented in
  `account.ts:64` and `integrations.ts:399`.

### MCP vs REST

MCP shares one server factory (`mcp/session.ts`, `mcp/index.ts`, `mcp/http.ts`)
and its scheduling/publishing tools call shared services. However
`mcp/server.ts:316,350` call `deps.jobStore.enqueue(...)` directly with hardcoded
`provider: 'content'`, contradicting the file header (`mcp/server.ts:23-24`).

### Contracts

- `ApiEnvelope`/`ApiErrorBody`/`ApiResult` (`contracts/src/api.ts:27,33,42`) are
  imported nowhere in `apps` or `apps/web` — dead contract surface.
- Unused contract modules: `compositionPlanFixtures`, `documentFixtures`,
  `designPackage` (test-only/future).
- `services/contentAiService.ts` and `services/contentAiEditService.ts` overlap
  (`content.ts:204,230`), with the latter importing helpers from the former.

---

## 6. Auth / authz architecture

Chain: **Authentication -> User identity -> Project authorization -> Platform-
admin authorization**, plus secondary trust systems.

- **Authentication:** Supabase JWT/JWKS (RS256) with HS256 fallback
  (`auth/jwt.ts:1-26,97`); Express wiring `http/middleware.ts:23-31`. `/me`
  bootstrap by `user_id` (`routes/me.ts:20,42-45,100-102`).
- **Identity systems (four, by design):** Supabase human session; Google Login
  (Supabase provider, identity only — `App.tsx:782`, `docs/google-login-setup.md:33`);
  signed OAuth `state` for vendor connects (`infra/signedPayload.ts:15-42`);
  API keys (`seo_api_keys`, scoped, hashed — `infra/apiKeys.ts:61-80,189-197`).
- **Project authorization:** single primitive `AccessService.requireRole`
  (`supabase.ts:143-155`), reused by REST (`v1.ts:77-98`), worker and MCP
  (`mcp/server.ts:140`). Route-def scan found every project-scoped router pairs
  handlers with a check; exceptions are legitimately unscoped (`catalog.ts:22`,
  `me.ts`, `oauth.ts`).
- **Platform admin:** route guard (`routes/admin.ts:29,36-41`) plus scoped SQL
  re-verification (`platformAdminService.ts:39-45`); registry keyed by `user_id`,
  RLS deny-all, service-role only (`20260101000032_platform_admins.sql:4-23`).
- **Account ownership:** `seo_accounts.owner_user_id` UNIQUE (one user = one
  account, `20260101000011_accounts.sql:25-33`); no `seo_account_members`.
- **RLS boundary:** server client is service-role and **bypasses RLS**
  (`supabase.ts:37,104`; `context.ts:99`), so safety depends on every route
  calling `requireRole`/`requireAccount`.

Flagged issues:

1. Misleading comment `context.ts:39` claims "RLS still applies
   (auth.uid = your user)" on the service-role client; `supabase.ts:37,104`
   says the opposite. Could mask a missing authz call.
2. Email used as identity in `seo_add_project_member`
   (`20260101000006_rls.sql:390` -> `auth.users.email`, web `lib/members.ts:42`).
   Functional but an identity-key smell.
3. Client state used as UI authz and duplicated: `App.tsx:302-304`
   (`isAdmin`), `views/admin/AdminArea.tsx:52`, `ProjectSettings.tsx:63`,
   `Keywords.tsx:76`, `components/scheduling/scheduleMeta.ts:13,24-25`,
   `components/analytics/AnalyticsPropertyPanel.tsx:32`.
4. `ROLE_RANK` re-implemented client-side three times
   (`workspaceSession.tsx:61`, `views/Designer.tsx:50`, `views/Compose.tsx:46`)
   mirroring `supabase.ts:150`.
5. Dead/legacy: `accountService.resolveAccountId` exported but unused
   (`accountService.ts:36`); `seo_is_member`/`seo_has_role` and
   `created_by = auth.uid()` policies remain defined though superseded
   (`20260101000006_rls.sql:190,198-203`), removed by `...000034`.
6. Three independent bearer-token parsers (`auth/jwt.ts:108-111`,
   `mcp/http.ts:60-64`, inline in `v1.ts`).
7. API-key scopes lack a DB CHECK; enforcement is application-side
   (`docs/codebase-security-audit.md:174`, `mcp/server.ts:101-105`).

No missing route-level project check was found.

---

## 7. Google OAuth architecture audit

**Question: Can Google Ads be added as another provider using the current OAuth
architecture without introducing a second OAuth system? — Yes.** The reusable
core is provider-agnostic; the gaps are additive.

Shared primitives:

- One platform Google API client `GOOGLE_CLIENT_ID/SECRET`
  (`config.ts:49-50`), used by GSC and GA4 (`account.ts:211,355`,
  `integrations.ts:274`, `googleAnalyticsService.ts:134`). Supabase Google
  Login is separate by design.
- Scaffolding: `buildAuthorizationUrl`/`exchangeCode`/`refreshAccessToken`
  (`providers/gsc/oauth.ts:47-131`), HMAC-signed state
  (`infra/signedPayload.ts:15-42`, 30-min TTL), AES-256-GCM credential store
  (`crypto.ts:42-63`, `infra/credentials.ts:74-157`), account-scoped
  `seo_integrations` with partial unique `(account_id, provider_type)`
  (`20260101000013_account_scoped_integrations.sql:42-44`).

Duplicated / divergent machinery:

- Two hardcoded callbacks (`routes/oauth.ts:44-116` GSC vs `:126-195` GA4),
  **not** the provider-aware `/api/oauth/google/callback` promised by
  `docs/google-analytics-recon.md:106-109`.
- Two token read/refresh/retry implementations (`gscDataSource.ts:142-160` vs
  `googleAnalyticsService.ts:122-155`); refresh is lazy-on-401 only.
- Two scope constants repeating `openid`+`email` (`gsc/oauth.ts:19-23`,
  `ga4/scopes.ts:12-16`); no central scope registry or scope validation.
- Separate connect/disconnect route pairs and integration-lookup helpers
  (`account.ts:159-283` vs `:294-393`; `accountService.ts:60-79` vs
  `googleAnalyticsService.ts:84-96`).
- A third legacy project-scoped GSC OAuth path (`integrations.ts:256-280`).
- GA4 bypasses the provider abstraction entirely (not in `registry.ts`).
- Doc/code mismatch: scope is stored in credential `meta.scope`
  (`oauth.ts:95,173`), not a `google_token_scope` key; the disconnect deletes of
  `google_token_scope` (`account.ts:383`, `gscDataSource.ts:200`) are written
  nowhere and are no-ops. `nonce` is generated but never persisted/checked
  (`oauth.ts:180-186` email is display-only).

Ads gaps (none is a second OAuth system): a new callback handler or the
provider-aware refactor; a `google_ads` scope + consent-screen update
(`oauth-scope-justification.md:76` currently excludes Ads); a developer token
and typically `login-customer-id` (no such env var, `config.ts:48-50`); a
customer-id discovery + project binding analogous to `seo_project_analytics`
(`20260101000033_google_analytics.sql:20-49`); a provider-vs-bespoke decision;
and an update to the Google verification story.

---

## 8. Provider audit

| Provider | Classification | Evidence |
| --- | --- | --- |
| DataForSEO | COMPLETE (real API, only provider with retry + circuit breaker) | `providers/dataforseo/dataForSeoClient.ts:24-26,285`; `dataSource.ts:147-473` |
| GSC | COMPLETE | `providers/gsc/gscDataSource.ts:96-274`; `gscApi.ts:14,91` |
| GA4 | COMPLETE but ARCHITECTURAL OUTLIER (not registered, not metered) | `providers/ga4/googleAnalyticsClient.ts:20-122`; `services/googleAnalyticsService.ts` |
| Google Ads | ACTUAL GAP (no code) | zero matches repo-wide |
| Website crawler | ACTUAL GAP (declared id, no adapter) | `contracts/src/common.ts:15`; `jobs/enqueue.ts:23-24` throws not-configured |
| Qdrant + embeddings | COMPLETE | `providers/qdrantKnowledge.ts:53-217`; `knowledge/embedding.ts:54-136` |
| Jina fetch/discovery | COMPLETE | `providers/jina/jinaKnowledgeFetcher.ts:79-164` |
| Cohere rerank | COMPLETE, opt-in/off by default | `providers/reranker.ts:20-28`; `rerank/cohereReranker.ts:36-131` |
| OpenAI AI | COMPLETE | `providers/ai/openai.ts:56-233` |
| Media (OpenAI/Unsplash) | COMPLETE | `providers/media/openaiMedia.ts:34-127`; `unsplash.ts:38-127` |
| WordPress | COMPLETE | `providers/wordpress.ts:44-199` |
| X | COMPLETE for text; update/delete honest not-available | `providers/social/xPublisher.ts:212-243` |
| mock_social | MOCK, gated behind `ENABLE_TEST_PUBLISHERS` (default false) | `registry.ts:297-315`; `config.ts:114` |
| LinkedIn/Facebook/Instagram/TikTok/etc. | ACTUAL GAP | zero references |

Cross-cutting:

- Duplicated HTTP clients everywhere, but most share `http/fetchTimeout.ts`;
  **Jina and Cohere hand-roll `AbortController`** (`jinaKnowledgeFetcher.ts:103`,
  `cohereReranker.ts:67`).
- Retry is inconsistent: only DataForSEO has retry + breaker; GSC/X refresh
  once on 401; WordPress/Unsplash/OpenAI/Qdrant/Jina/Cohere have none.
- Provider-specific ids leak into generic services: `getKnowledge('qdrant')`
  (`knowledgeService.ts:464`, `executors.ts:594-641`), `getMedia('unsplash')`
  (`imageInsertionService.ts:333`), `source: 'unsplash'` inside a generic
  `MediaProvider` path (`externalImageAcquisition.ts:203,230`), hardcoded
  `gsc`/`dataforseo` in `contentIntelligenceService.ts:112-400` and
  `executors.ts`, `DEFAULT_PROVIDER='openai'` (`aiService.ts:41`).
- `SeoDataSource` optional methods are **stubs** on DataForSEO
  (`dataSource.ts:458-473` return empty) and absent on GSC; real work is on
  concrete classes called directly by executors.
- `EmbeddingService`/`ProjectEmbedder` explicitly `@deprecated`, no caller
  (`embeddingService.ts:21-52`).

---

## 9. Publishing audit

Production-capable:

| Destination | Flow | Evidence |
| --- | --- | --- |
| WordPress | UI -> service -> provider -> real WP REST (publish/update/delete) | `views/Publishing.tsx:272-458`; `routes/publications.ts:100-214`; `publicationJobs.ts:172-199`; `executors.ts:744-848`; `wordpress.ts:105-198` |
| X (text) | UI -> OAuth (PKCE + signed state) -> provider -> real API | `publisherOAuthService.ts:109-238`; `xOAuth.ts:196-290`; `xPublisher.ts:212-235` |
| Scheduled flow | both, via `scheduleService.ts:367` + same executor | `publicationJobs.ts` |

Not production:

| Destination | Flow |
| --- | --- |
| LinkedIn / Facebook / Instagram / TikTok / other | ACTUAL GAP — no UI, route, service or provider |
| mock_social | UI -> stub; only registered when `ENABLE_TEST_PUBLISHERS=true`; labeled "Test/demo provider" (`registry.ts:308`) and emits no usage (`publishing/providerUsage.ts:6`) |

Observations: `Publications.tsx:75-288` is read-only history (correct/honest);
the `schedule` capability is declared only by X (`registry.ts:280`) yet nothing
gates on it — gating uses `publisherCanPublishKind` (`publications.ts:48-54`,
`scheduleService.ts:367`); duplicate publish is guarded at route and executor
with an acknowledged residual window (`publications.ts:240`,
`executors.ts:818-837`); WordPress `disconnect()` is a no-op (`wordpress.ts:161`).

---

## 10. Database / migration archaeology

- **`dist/supabase-schema.sql` does not exist**; `/workspace/dist` is absent and
  gitignored. The consolidated-SQL artifact referenced by `CLAUDE.md:21` and
  `deploy/README.md:268` is missing. The migration chain is the only schema
  source of truth.
- 35 migrations (`20260101000001`..`20260101000035`), ~36 `seo_*` tables.

Suspicious items:

| Item | Class |
| --- | --- |
| `seo_integrations.project_id` nullable alongside `account_id` (dual scope, two partial unique indexes) — `20260101000013:31,36` | LEGACY BUT STILL NEEDED (high future migration risk) |
| `seo_data_sources` project-scoped duplicate of `seo_project_properties` + `seo_gsc_properties` — `20260101000002` | LEGACY BUT STILL NEEDED; GSC subset SAFE CANDIDATE FOR FUTURE REMOVAL |
| `seo_publishers` still project-scoped while Google is account-scoped | LEGACY BUT STILL NEEDED |
| `seo_credentials` three-way owner (`integration_id`/`publisher_id`/`project_id`, `num_nonnulls=1` — `20260101000008:17`) | LEGACY BUT STILL NEEDED |
| `seo_content.body`, `keywords`, `seo_meta` — never read/written by API code; canonical is `content_json`/`content_html`/`outline` (`contentService.ts:4-6,130`) | SAFE CANDIDATE FOR FUTURE REMOVAL (`seo_meta` still in contract `models.ts:310,323` — verify) |
| Legacy GSC attach route + `seo_data_sources` GSC rows | LEGACY BUT STILL NEEDED (external consumers UNKNOWN) |
| `seo_gsc_properties` account-scoped while GSC metrics stay project-scoped | Intentional boundary, flag only |
| `did_you_mean` (0 refs), `content_type` (knowledge only), `permission_level`/`verified_at` (accountService only) | Monitor |

Forward-only migrations with no residue: `...000027` (data-source uniqueness),
`...000034` (removed `created_by` owner backdoor), `...000035` (per-project job
idempotency).

No data model was found that forces a large migration **before P5**; the dual
scope is the main long-term item and it is bounded.

---

## 11. Frontend architecture audit

- Hand-rolled router, no library: `lib/projectRoute.ts`, `lib/historyNavigation.ts`,
  `lib/navigationBarrier.ts`; single shell `App.tsx:130`; lazy views `App.tsx:48-67`.
- Hardcoded nav: `TOP_NAV`/`PROJECT_NAV` (`App.tsx:89-109`);
  `WorkspaceModeSwitcher` and `KnowledgeNavigation` keep their own lists.
- Retired-but-recognized surfaces: `projectRoute.ts:10,114-125`,
  dead placeholder branches `App.tsx:405-407,458`.
- Unreachable screens: `views/Data.tsx` (316 lines, zero importers),
  `components/content/ContentEditorHeader.tsx` (re-export shim, zero importers).
- Giant components (non-test lines): `views/Keywords.tsx` 2194,
  `components/content/WriterPanel.tsx` 1508, `App.tsx` 888, `EditorView.tsx` 660,
  `views/Designer.tsx` 622, `views/Publishing.tsx` 599, `SourcesPage.tsx` 594,
  `views/Compose.tsx` 538.
- Duplicated state/role logic: `ROLE_RANK` x3 (see §6); `canEdit` derived in 10+
  files; six overlapping contexts (documented as projections, but broad surface).
- Transport: one HTTP client `lib/api.ts`; direct Supabase RPC bypasses it in
  `lib/members.ts:32-72`, `App.tsx:637`, `views/ProjectsPage.tsx:50`.
- Loading/error: shared `useAsync` (`lib/ui.tsx:42`), but the error-banner markup
  is hand-repeated ~49 times across ~37 files; `Keywords.tsx` has 16 banners and
  13 separate error states. `Keywords.tsx` and dead `Data.tsx` duplicate the same
  keyword/ranking surface.
- `useJobs`/`JobTable` are untyped `any[]` (`lib/ui.tsx:138-167`), enabling §15 B1.

---

## 12. Configuration audit

- API schema has 47 keys (`config.ts:29-139`); `.env.example` is in sync (no
  drift either direction).
- Truly unused: `SUPABASE_ANON_KEY` (`config.ts:36`, `.env.example:13`) — never
  read in `apps/api`; `supabaseConfigured` uses URL + service-role only
  (`config.ts:191`).
- Schema bypasses: `LOG_LEVEL` is declared but the logger reads
  `process.env.LOG_LEVEL` directly (`logger.ts:48`); `NODE_ENV` read directly in
  `diagnostics/compositionPlannerSmoke.ts:91`; `TZ` used in
  `scripts/schedule-date-utils-check.ts:24` but undocumented and not in schema.
- Frontend: only `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (`lib/supabase.ts:17`),
  both public; no `VITE_`-prefixed secret exists. Proxy + allowedHosts correctly
  set (`vite.config.ts`).
- Deployment split-brain: `vercel.json:5` hardcodes `https://api.peerdisco.com`;
  `deploy/README.md:201` documents `PUBLIC_APP_URL=https://oldskoolseo.com`.
- Worker and API share `@DEPLOY_ROOT@/shared/.env` with no worker subset
  (`deploy/systemd/seo-worker.service:12`).

---

## 13. Worker / job audit

Coherent core: one `JobStore` interface (`jobs/types.ts:46-67`) with Postgres
(`postgresJobStore.ts:156-170`, SKIP LOCKED) and Supabase (`supabaseJobStore.ts:131-156`,
CAS) backends selected by `SUPABASE_DB_URL` (`context.ts:102-110`); one worker
loop (`worker.ts:104,227`) with retry budget (`:141-152`), stale sweep (`:34`),
shared `reliability/retry.ts` + `circuitBreaker.ts`.

Main incoherence — **three independent job-type registries**:

1. `JOB_PROVIDER` — 12 types (`jobs/enqueue.ts:17-29`), only used by `enqueueJob:122`.
2. `EXECUTORS` — 21 types (`jobs/executors.ts:1065-1085`).
3. `PUBLISH_JOB_TYPES` — ad hoc (`worker.ts:207`).

`JOB_PROVIDER` is missing 10 executed types (`knowledge_source_*`,
`content_generate`, `content_write`, `content_images`, `content_analyze`,
`agent_design`, `publish`, `publish_update`, `publish_delete`) and lists
`website_crawl`/`website_audit` which have no executor. Consequently those 10
types cannot use `enqueueJob` and bypass the shared gate via direct
`jobStore.enqueue` at: `knowledgeService.ts:1229,1781,1827,1843`,
`contentDraftService.ts:178`, `agentRunService.ts:237,431`,
`publicationJobs.ts:182`, `scheduleService.ts:195`, `content.ts:87,108,266`,
`v1.ts:178`, `opportunities.ts:204`, `mcp/server.ts:316,350`. The generic
`/jobs` route also cannot set `idempotency_key` (`routes/jobs.ts:34-42`).

Parallel execution models: `AgentRunService` (second durable lifecycle over
`seo_agent_runs` + `reconcileOrphanedRuns`, `worker.ts:89`) and `WriterRunService`
(LangGraph checkpointer + background resume, no `JobStore` at all —
`writerRunService.ts:738,834,1211`).

Correctness gaps: cancellation of a running job is ineffective —
`cancel` sets `canceled` regardless of state
(`supabaseJobStore.ts:217-222`, `postgresJobStore.ts:220-222`), executors never
check cancellation, and terminal writes are unconditional
(`worker.ts:153`; `supabaseJobStore.ts:167-172`), so a later `complete`/`fail`
overwrites `canceled`; the route comment admits this (`jobs.ts:80-82`).
`isJobExpired` (`executors.ts:1091`) and `safeDelay` (`:1097`) have no non-test
callers. The circuit breaker is wired only into DataForSEO
(`dataForSeoClient.ts:26`).

Answer: **partially reusable.** A new feature would tend to add a fourth
registry/entry rather than reuse the gate.

---

## 14. Usage / metering audit

- Single append-only seam: `usageEventRepository.ts` (only insert at `:236`,
  validation `:114-156`, unique-violation swallow `:109`); no direct writer
  bypass found. Helper `usageInstrumentation.ts:97-269`; vocabulary contract
  `packages/contracts/src/usageEvent.ts` + `docs/r5.10.1-usage-vocabulary.md`;
  read API `routes/usage.ts`.
- Metered: AI (`aiService.ts:188`), DataForSEO (`providerUsage.ts:42-111`), GSC
  (`gsc/providerUsage.ts:40-79`), publishing (`publishing/providerUsage.ts:76-130`),
  media (`media/mediaUsage.ts:27-68`), embeddings
  (`knowledge/embeddingUsage.ts:59-114`), job terminal facts (`worker.ts:155,177,196`).

Consistency findings:

- **GSC emits category `dataforseo`** (`providers/gsc/providerUsage.ts:50`) with
  provider `gsc` — misleading and won't scale to a second data vendor.
- Job facts (`category: job`) are emitted in addition to per-provider facts for
  the same work (different categories, by design; must be documented in UI).
- Account scope depends on a DB trigger, not context (`ProviderUsageContext`
  carries `projectId`/`userId`, no `accountId` — `contracts/src/providers.ts:84`).
- **GA4 is completely unmetered** (no usage wiring in `providers/ga4/*` or
  `googleAnalyticsService.ts`) — inconsistent with GSC.
- `document` category declared but not emitted.
- The `category` CHECK is closed, so Ads needs either a `google_ads` category +
  ad units or a fold into the generic data category (repeating the GSC
  mislabel). No schema change is strictly required, but existing idempotency
  keys/history constrain renaming.

---

## 15. Contract integrity audit (API/UI)

- **B1 (live bug):** `SyncJob.error` is `JobError` (required `message`,
  `contracts/src/models.ts:498-533`) but `lib/ui.tsx:174` interpolates it as a
  string -> `[object Object]`; `Keywords.tsx:2044` treats it as an object;
  `AgentControls.tsx:29` types it correctly. Root cause: untyped `any[]` in
  `useJobs`/`JobTable` (`lib/ui.tsx:138-167`).
- **B2:** GA4 DTOs duplicated locally (`lib/analytics.ts:13-46`) instead of
  importing `contracts/src/analytics.ts:12-69`; web widens
  `period.days: number` losing `AnalyticsPeriodDays = 7|28|90`.
- **B3:** `/account` parsed with three divergent local shapes
  (`Overview.tsx:22-83`, `AccountIntegrations.tsx:29-61`, `ProjectsPage.tsx:19-30`)
  while `AccountDto` exists (`contracts/src/api.ts:1496`).
- **B4:** `/providers` catalog re-declared and truncated in
  `Integrations.tsx:20-31` (drops `ai`/`media`) and again in `Publishing.tsx:92`
  — exactly the area Ads will touch.
- **B5:** duplicates of `PublicationDto` (`Publishing.tsx:58-68`),
  `ProjectGscStateDto` (`ProjectSettings.tsx:25-44`), and hand-written
  keyword/page/rank rows in dead `Data.tsx:23-45`.
- **B6:** `/dashboard` reconstructed in `Dashboard.tsx:19-25`; `position` typed
  required but rendered nullable (`:22` vs `:157`); `sources.*` typed `any[]`.
- **B7:** `lib/api.ts:41-59` returns `json.data as T` / `undefined as unknown as T`
  with no runtime validation; 87 of 148 `api()` call sites pass no type argument.

---

## 16. Dead code / dependency archaeology

- **Zero** `TODO`/`FIXME`/`HACK`/`XXX` markers in source.
- Dead files: `apps/web/src/views/Data.tsx` (zero importers);
  `apps/web/src/components/content/ContentEditorHeader.tsx` (re-export shim);
  `apps/api/src/services/embeddingService.ts` (`@deprecated`, no caller).
- Genuinely dead exports (definition only): `roleAtLeast`, `clampPercent`,
  `nullToZero` (`contracts/src/common.ts`); `emptyBlocks` (`content.ts`);
  `contentOutlineOf` (`contentDoc.ts`); `firstOf` (`apps/api/src/util.ts`);
  `PROVIDER_DISPLAY` (`routes/utils.ts`); `generateKey` (`crypto.ts`);
  `ApiEnvelope`/`ApiErrorBody`/`ApiResult` (`contracts/src/api.ts`).
- Doc points at a removed symbol: `imageGenerationUsageEvent` cited in
  `docs/r5.10-closeout-recon.md` (C4) no longer exists.
- Dependencies: every declared dependency in all three packages has at least one
  repo reference; no unused runtime dependency. Minor manifest drift:
  API `vitest ^2.1.2` vs web/contracts `^2.1.9`.
- Both job stores live by design (`context.ts:107,110`); `mock_social` is
  env-gated and intentional.

---

## 17. Documentation drift

| # | Doc claim | Code reality | Class |
| --- | --- | --- | --- |
| D1 | Google login "not implemented at all"; no `signInWithOAuth` (`production-readiness-recon.md:197,208,215,402,414-421,551,573`) | Implemented: `App.tsx:782,812-819` | STALE (blocker no longer valid) |
| D2 | `/api/health` exposes derived `google`/`credentials_encryption` booleans and operators should verify config via them (`production-readiness-recon.md:276-277,472,546-547`) | Liveness-only `{ok,service}` (`app.ts:137-139`); DB gate on `/api/ready` (`app.ts:146-153`) | **DANGEROUS** (operator verification is impossible as documented) |
| D3 | `dist/supabase-schema.sql` is a paste-ready deliverable (`CLAUDE.md:21`, `deploy/README.md:268`) | File absent; `dist/` gitignored | **DANGEROUS** (documented deploy input missing) |
| D4 | Topology rewrites `/api` to `http://144.172.102.63/...` (`production-readiness-recon.md:39,56,443`) | `vercel.json` rewrites to `https://api.peerdisco.com` | STALE |
| D5 | Provider-aware `/api/oauth/google/callback` (`google-analytics-recon.md:109`) | Two hardcoded handlers `/gsc/callback`, `/ga4/callback` (`oauth.ts:44,126`) | MINOR |
| D6 | Scope stored as `google_token_scope` (`google-analytics-recon.md:42`, `google-analytics-setup.md:55`) | Stored as credential `meta.scope` (`oauth.ts:95,173`); deletes of `google_token_scope` are no-ops | MINOR/MATERIAL |
| D7 | "34 migrations" (`codebase-security-audit.md:16`) | 35 migration files | MINOR |
| D8 | R5.2.2 `EditorWorkspace` reads `useRequiredDocumentSession` (`r5.2.2-session-context.md:42-48`) | Provider mounted but unread; `EditorWorkspace` takes props | MINOR |
| D9 | R5.5.5 line refs to `App.tsx:286-287`/`PROJECT_NAV` | tree moved on; behavior still holds | MINOR |
| D10 | No root `README.md` | absent; only `deploy/README.md` | MINOR |

Docs that match code: `production-administration-recon.md`,
`p1-hardening-recon.md`, `platform-admin-bootstrap.md`,
`oauth-scope-justification.md`, GA setup docs, `phase-5-roadmap.md`.

---

## 18. Product completeness matrix

| Area | Status | Actual implementation | Debt | Future risk | Recommended action |
| --- | --- | --- | --- | --- | --- |
| Auth | COMPLETE | Supabase JWT/JWKS, `/me`, Google login | email-as-identity in member RPC; duplicated client role logic | low | Align docs; keep single `requireRole` |
| Account | COMPLETE | `seo_accounts` ownership, BYOK, API keys | no account members; DTO duplication | medium | Contract-share account DTOs |
| Project admin | COMPLETE | `seo_project_members` + `requireRole` | route-level business logic | low | Move inline DB logic to services |
| Platform admin | COMPLETE | `seo_platform_admins` + scoped RPCs | none material | low | none |
| Usage | PARTIAL | central ledger, single write seam | GA4 unmetered, GSC category mislabel, closed CHECK | medium/high | Meter GA4; decide Ads category |
| Workspace | COMPLETE | one session/loader/autosave/selection owner | vestigial `DocumentSessionContext`; popstate hold bypass | low | Remove/alias seam; fix popstate |
| Composer | COMPLETE | `ComposerMode` + `Compose` + bridge | none material | low | none |
| Designer | COMPLETE (UI) | `DesignerMode` + revision-bound proposals | server API is INTENTIONAL LEGACY for MCP | low | Keep |
| Editor | COMPLETE | `EditorMode`/`EditorView` on `content_json` | giant `EditorView`; G5 toolbar default | low | Split gradually |
| Preview | COMPLETE | read-only `CanonicalRenderer` in sandboxed iframe | fonts in-frame; large static bundle | low | none |
| GSC | COMPLETE | real data source + account property registry | legacy project GSC path; scope-key no-op | medium | Retire legacy path post-backfill |
| GA4 | COMPLETE | real client/service + project binding | not in registry, not metered, DTO dup | medium | Register/meter before Ads |
| Google Ads | ACTUAL GAP | none | needs callback/scope/dev-token/customer-id/metering | high | Plan P5 with prerequisites |
| Keyword research | COMPLETE | DataForSEO jobs + `seo_keywords` + snapshots | registry bypass; giant `Keywords.tsx` | medium | Unify job gate |
| Competitor research | COMPLETE | `competitor_research` discover/gap | opportunity reads only `competitor_gap` | medium | Extend deliberately in P6 |
| Content | COMPLETE | structured `content_json` source of truth | `seo_content` legacy columns; duplicated AI services | low | Drop legacy cols later |
| Publishing | PARTIAL | WordPress + X real; others absent | project-scoped vs account split; schedule capability unused | high (claims) | Only claim WP + X |
| MCP | COMPLETE | shared services, HTTP + stdio | two tools enqueue directly | medium | Route through services |
| Worker/jobs | PARTIAL | durable queue + one worker | registry split, bypass, ineffective cancel | high | Unify registry + fail-safe enqueue |
| Media | COMPLETE | OpenAI + Unsplash, provenance | `unsplash` leak in generic path | low | Provider-agnostic selection |

Statuses use only: COMPLETE / PARTIAL / INTENTIONAL STUB / DEFERRED / LEGACY /
ACTUAL GAP.

---

## 19. Future-change risk analysis

Cheap now, expensive later:

1. **Job-type registry split (`JOB_PROVIDER` vs `EXECUTORS`) + enqueue bypass.**
   NOW COST small; LATER COST large; BREAKING RISK medium. A fourth registry for
   Ads is the likely failure mode.
2. **Usage vocabulary (`dataforseo` category for GSC, closed `category` CHECK).**
   NOW COST small; LATER COST medium/large; BREAKING RISK medium (idempotency
   keys/history).
3. **Google OAuth callback/bespoke-provider duplication.** NOW COST medium;
   LATER COST medium/large; BREAKING RISK medium. Ads would otherwise copy the
   GA4 outlier.
4. **Frontend DTO duplication of `/providers` and `/account/analytics`.**
   NOW COST medium; LATER COST medium; BREAKING RISK low/medium. Ads touches
   exactly these.
5. **Service-role client has no second authz net; misleading `context.ts:39`
   comment.** NOW COST small; LATER COST large; BREAKING RISK high.
6. **Dual project/account integration ownership + project-scoped publishers.**
   NOW COST large; LATER COST large; BREAKING RISK high — but not needed for P5.
7. **`/api/v1` content routes drifting from session routes.** NOW COST small;
   LATER COST medium; BREAKING RISK medium (agent clients).
8. **Worker cancellation ineffective.** NOW COST medium; LATER COST medium;
   BREAKING RISK low.

No overall score is assigned.

---

## 20. P5 readiness (Google Ads)

| Dimension | Answer |
| --- | --- |
| OAuth | Yes — reuse the one platform Google client, signed state, AES credential store, account-scoped integrations. Prerequisite: a third callback handler **or** the provider-aware callback, plus an `adwords` scope and consent-screen update. |
| Database | Yes — an account-scoped `seo_integrations` row works with the existing partial unique index; add a customer-id project binding analogous to `seo_project_analytics`. No ownership-model change. |
| API | Yes — fits service/route/registry. Decide up front: register Ads as a proper provider (like GSC) instead of copying the GA4 outlier. |
| Usage | Yes at the ledger level, but the `category` vocabulary must be extended (new `google_ads` category + ad units) rather than folding into `dataforseo`. GA4 is currently unmetered and should be fixed as a template. |
| Project model | Yes — the same `requireRole` path; no new membership/authorization model. |
| UI | Account-level connection (`AccountIntegrations.tsx`) + project-level data binding (`projectAnalytics`-style), consistent with GA4. |
| Configuration | Add `GOOGLE_ADS_*` (developer token, optionally login-customer-id) to `config.ts` schema + `.env.example`. |
| Testing | Yes — existing vitest + migration harness cover a new provider/route without structural change. |

**Verdict: READY WITH SMALL PREREQUISITE.**

**No architectural blocker found for P5.**

The prerequisites are consolidations already identified as cheap-now: unify the
job-type gate (or at least register content/publish/agent types), decide the
provider pattern for Google data sources, meter GA4, and share the Ads-touched
frontend DTOs.

---

## 21. P6 readiness (competitor keywords, Google search inspiration)

- Canonical project keyword model exists: `seo_keywords` with natural key
  `(project_id, provider, source, keyword)` (`20260101000003_seo_entities.sql:11-33`);
  reusable snapshot store `seo_source_snapshots` (`20260101000028:26-47`) and
  scope/hash (`sourceScope.ts:37,57`); persistence gateway
  `persistence/seoWriter.ts:289-398`. There is deliberately no opportunity table
  (`contracts/src/api.ts:1662`); opportunities derive on read
  (`opportunityService.ts:189-219`).
- Competitor keywords already partially exist as `competitor_gap`
  (`dataForSeoClient.ts:531`, `dataSource.ts` `findCompetitorKeywordGaps`,
  `executors.ts:484-505`, `seoWriter.ts:317`).
- Inspiration queries naturally extend keyword expansion
  (`KeywordExpansionMethod` `contracts/src/api.ts:1839-1842`; provider
  `keywordSuggestions:382`, `relatedKeywords:412`, `keywordIdeas:444`).
- Job model is suitable (free-text `job_type` + `params jsonb` + `result jsonb`,
  `20260101000005:11-38`); result/snapshot model is suitable.
- **Migration needed?** No, if inputs land as `seo_keywords` rows under a new
  `source` and/or as `params`/`result` on the existing
  `dataforseo_keyword_research`/`competitor_research` jobs. Yes, only if a new
  `seo_source_snapshots.type` is chosen (closed CHECK
  `20260101000028:39-40`, plus `SOURCE_SNAPSHOT_TYPES`/`FRESH_MS` and the
  projection in `sourceSnapshotService.ts:166`).
- Conflicts: `KEYWORD_EXPANSION_METHODS` is a closed union driving metric
  precedence (`keywordExpansionService.ts:159-222`); opportunity analysis reads
  only `competitor_gap` (`opportunityService.ts:196-199`); `enqueue.ts`
  `KNOWN_JOB_TYPES` rejects unregistered types.

**Verdict: READY** (no migration required for the natural design; small contract
edits).

---

## 22. Landing-page / product claim readiness

### REAL

- Project-scoped SEO workspace: keyword research, competitor research, content
  authoring/editing, preview, knowledge base, scheduling.
- GSC integration (account-level connection + project property binding).
- GA4 integration (page-traffic intelligence).
- WordPress publishing (publish/update/delete) and X text publishing (OAuth).
- AI writing/composition/design agent and media (generated + stock) with BYOK.
- Usage metering/reporting, account/project management, platform admin.

### PARTIAL

- Publishing (only WordPress and X; text-only for X, no update/delete).
- Usage (GA4 unmetered; category naming misleading).
- Worker-jobs (works, but registry split and ineffective cancellation).
- Designer server API (retained for MCP, no longer a web surface).

### INTERNAL

- Platform admin area, usage ledger internals, MCP server (stdio + HTTP),
  REST `/api/v1` agent API, provider catalog.

### FUTURE

- Google Ads, website crawler, LinkedIn/Facebook/Instagram/TikTok publishing,
  competitor-keyword and Google-inspiration inputs, DesignPackage runtime.

Do not write marketing copy from this section; use it to constrain claims.

---

## 23. Final debt register

```text
NOW
-----
- Unify job-type ownership (JOB_PROVIDER vs EXECUTORS vs worker PUBLISH_JOB_TYPES);
  route every enqueue through one gate that supports idempotency_key.
- Fix usage vocabulary before Ads: decide/replace the GSC `dataforseo` category
  and the closed category CHECK; meter GA4.
- Decide the provider pattern for Google data sources (register GA4/Ads as
  providers) instead of copying the bespoke GA4 outlier.
- Share the Ads-touched frontend DTOs (/providers, /account/analytics).
- Fix documentation that can mislead operators: D2 (/api/health) and D3
  (missing dist/supabase-schema.sql).
- Correct the RLS comment at context.ts:39.

NEXT
----
- Provider-aware Google OAuth callback (retire the duplicated GSC/GA4 handlers)
  while adding Ads.
- Route MCP content tools through services (remove direct jobStore.enqueue).
- Make worker cancellation conditional and terminal transitions status-guarded.
- Remove dead/orphan code: views/Data.tsx, ContentEditorHeader.tsx,
  embeddingService.ts, dead contract exports/modules.
- Retire the legacy project-scoped GSC attach path and seo_data_sources GSC rows
  after a backfill audit.

LATER
-----
- Account-scope publishing (seo_publishers) and collapse the three-way
  seo_credentials owner.
- Remove seo_content legacy columns (body/keywords/seo_meta) once verified
  unused by contract consumers.
- Split giant components (Keywords.tsx, WriterPanel.tsx, App.tsx).
- Error taxonomy consistency (provider -> ApiError mapping; request_id in the
  contract).

DEFERRED
--------
- popstate bypass of the Composer/Designer review hold.
- Bookmark/reconnect policy and workspace-level idempotency keys.
- DesignPackage runtime integration.
- Selection-clear boundary (R5.11 H10).

IGNORE
------
- Dual JobStore backends (intentional: SKIP LOCKED vs CAS).
- mock_social (env-gated, default off).
- Cohere rerank default-off.
- Missing root README (deploy/README.md is the operative doc).
```

---

## 24. Recommended next sequence

1. **Small pre-P5 cleanup (NOW items):** unify the job gate, fix usage vocabulary
   + meter GA4, decide the Google provider pattern, share Ads-touched DTOs,
   correct D2/D3 docs and the RLS comment. None requires a schema redesign.
2. **P5 Google Ads:** implement on the shared Google OAuth client with the
   provider-aware callback, account-scoped integration, customer-id project
   binding, `google_ads` usage category.
3. **P6 keyword/competitor inputs:** extend `seo_keywords` sources / existing
   jobs and snapshots; no schema migration for the natural design.
4. **Landing page:** use the §22 inventory; claim only REAL and clearly-scoped
   PARTIAL capabilities.
5. **Later debt:** account-scope publishing, legacy column removal, component
   splitting, error taxonomy.

No architectural blocker was found for either P5 or P6.

---

## Verification

Recon introduced no production code. Validation run on the current tree
(`fe3e2e2` + this doc only):

- Baseline commit: `fe3e2e2`.
- `pnpm typecheck`: passes (api + web, 0 errors).
- `pnpm test`: passes — contracts 506, api 1946, web 778 (all green; the log
  lines in the output are expected error-path assertions).
- `pnpm build`: passes (contracts + api `tsc`, web production build with
  per-route chunks).
- `git diff --check`: clean.
- Changed files for this recon: `docs/architecture-product-debt-recon.md` (new).
- Application behavior change: **NONE**.

Committed as `docs: add architecture and product debt recon` and pushed to
`origin/main`. No follow-up implementation commits were made.
