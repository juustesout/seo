# P6 — Product Completion Recon

Recon-only phase. No application, schema, test or dependency changes were made.
This document records the current product-completion baseline of Old Skool SEO
after P1–P5, R5 and the hardening/quality phases, and identifies what should
happen next.

Baseline validated at commit `3114f27` (P5 Google Ads): `pnpm test` green
(API + web), `pnpm lint` 0 errors, `pnpm build` green, and
`scripts/db-migrate-local.sh` green on a fresh database. Evidence below is
`file:line` against that tree.

---

## 1. Executive summary

Old Skool SEO today is **a real, project-scoped desktop SEO workbench** wrapped
around a strong provider/agent backend. The backbone is genuine: Google login,
projects and roles, GSC data ingestion, DataForSEO keyword/competitor research,
an AI content pipeline, a unified block workspace with preview, WordPress and X
publishing, a knowledge base, usage metering, and platform admin. Nothing found
is a faked data path; unconfigured capabilities are reported honestly.

What is **not** yet a finished product:

1. **The product cannot be driven from a phone.** The project sidebar is
   desktop-only (`App.tsx:595`) and there is no mobile replacement; inside a
   project a phone user can reach only the default view and whichever URL they
   already have.
2. **Google is three tools sharing a credential chassis, not one product.** GSC
   is deeply integrated (sync, dashboard, account overview); GA4 and Ads are
   thin live-read tables that are hardcoded into the account page and absent
   from the provider catalog. Period controls are inconsistent (GA4/Ads have
   7/28/90, GSC is fixed at 28).
3. **The measurement loop does not fully close.** GSC data persists and a real
   content↔GSC matcher exists, but GA4 page traffic is queried live and never
   stored, nothing links a publication to its traffic/search rows, and GSC sync
   is manual.
4. **Two agent surfaces produce output the user cannot adopt in place.** The
   Writer panel explicitly previews a draft it will not apply
   (`WriterPanel.tsx:808-826`); Designer creation-mode proposals cannot be
   applied because no content row exists yet.
5. **Research results are not retained as a product surface.** Keyword
   research/expansion runs live on the job row; persisted `seo_keywords` are
   only read by an orphaned view (`Data.tsx`), and the live "My keywords" tab
   reads GSC instead.

The first credible release does not need new providers. It needs the mobile
navigation, the two agent adoption paths, Google coherence, and a decision on
how far the measurement loop must close.

---

## 2. Current product model

Three navigational scopes, parsed in `lib/projectRoute.ts`:

- **Account scope** `/`, `/projects`, `/integrations`, `/keys`, `/usage`
  (`projectRoute.ts:10`, `App.tsx:91-97`).
- **Project scope** `/p/:projectId/:view` with sub-segments
  (`App.tsx:390-435`), sidebar `App.tsx:99-112`.
- **Platform admin** `/admin/*` (`projectRoute.ts:21-29`) and legal pages
  (`projectRoute.ts:15`).

Account navigation: Overview, Projects, Integrations, API keys, Usage.
Project navigation: Dashboard, Keywords, Analytics, Paid search, Integrations,
Knowledge Base, Workspace, Calendar, Publications, Publishing, Usage, Settings.

The intended loop (search/data → understand → create → publish → measure →
learn) maps to the code as follows:

```
SEARCH / DATA   GSC (persisted) + DataForSEO jobs + GA4/Ads live reads
UNDERSTAND      Keywords view (research/expand/competitors/opportunities/topics)
CREATE          Workspace (Composer / Designer / Editor) + Writer agent
PUBLISH         Publishing + Publications (WordPress real, X real text-only)
MEASURE         GSC dashboard + Analytics (GA4) + Content Intelligence
LEARN           Content Intelligence matches content to GSC pages (manual-loop)
```

Real today: the SEARCH→PUBLISH half is coherent and mostly real. MEASURE→LEARN
is real but narrow (GSC only, manual) and does not connect publications to
their traffic.

---

## 3. End-to-end user journey

| Step | Exists | Works | Discoverable | Coherent | Dead end / gap |
| --- | --- | --- | --- | --- | --- |
| Landing / entry | Partial | Login screen only | n/a | n/a | No product explanation before sign-in; landing page explicitly out of scope (`App.tsx:621-830`) |
| Google login | Yes | Yes | Auth screen | Yes | `signInWithOAuth` `App.tsx:786`, button `App.tsx:822` |
| Account | Yes | Yes | Top nav | Yes | Overview, Integrations, keys, usage |
| Create project | Yes | Yes | Forced first-run | Yes | No-project users get `CreateProject` `App.tsx:269-302`; copy `App.tsx:673-676` |
| Connect Google | Yes | Yes | Account Integrations / Settings | Partial | Connect + property/customer selection real; three products surfaced inconsistently |
| Inspect data | Yes | Yes | Dashboard/Keywords/Analytics/Paid search | Partial | GSC strong; GA4/Ads thin; period models differ |
| Create content | Yes | Yes | Workspace + Keywords "Create article" | Yes | Opportunity → article handoff exists (`Keywords.tsx:1251-1282`) |
| Design / edit | Yes | Yes | Workspace modes | Yes | Composer, Designer, Editor, Preview all present |
| Publish | Yes | WordPress + X | Publishing / Calendar | Yes | Only WP + X; X is text-only; no update/delete for X |
| Measure result | Partial | GSC strong, GA4 live | Dashboard/Analytics/Intelligence | Partial | No publication→traffic join; GA4 unpersisted; GSC sync manual |

The single strongest "what do I do next?" risk is not the first project (that
flow is forced and clear) but the **second session**: a return user sees a
dashboard and twelve sidebar entries, with no guided next action, and on mobile
no way to move between project views at all.

---

## 4. Product surface inventory

| Surface | Current state | User-facing | Product completeness | Evidence | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Auth | Google + email/password + magic link | Yes | COMPLETE | `App.tsx:786-822`; `App.auth.test.tsx` | none |
| Account | Owner model, BYOK, master keys | Yes | COMPLETE | `AccountIntegrations.tsx`, `AccountApiKeys.tsx` | add product onboarding copy |
| Projects | Create/list/switch, roles, members | Yes | COMPLETE | `App.tsx:269-302`; `MembersPanel.tsx:72-80` | no email invite flow |
| Project admin | Settings + members + bindings | Yes | COMPLETE | `ProjectSettings.tsx:114-302` | none |
| Platform admin | Read-only users/accounts/projects/usage | Yes (if admin) | COMPLETE | `routes/admin.ts:36-41`; `AdminArea.tsx:18-24` | out-of-band provisioning only |
| GSC | Account connect + project property + sync + dashboard | Yes | COMPLETE | `gscDataSource.ts`, `accountService.ts:379-494`, `Dashboard.tsx` | retire legacy path; add period picker |
| GA4 | Account connect + project property + live traffic table | Yes | PARTIAL | `googleAnalyticsService.ts`, `Analytics.tsx` | persist traffic; join to content; register provider |
| Google Ads | Account connect + customer binding + live term/keyword tables | Yes | PARTIAL | `googleAdsService.ts`, `AdsIntelligence.tsx` | decide product story; register provider |
| Keywords | Research / Expand / Competitors / Compare / Opportunities / Topics | Yes | COMPLETE (run-scoped) | `Keywords.tsx:2017-2024` | surface saved keywords; persist selection |
| Competitors | Discover + gap snapshot + opportunity feed | Yes | COMPLETE (domain-driven) | `competitorResearch.ts`, `Keywords.tsx:548-744` | no user keyword input |
| Composer | Plan → skeleton → AI slot fills | Yes | COMPLETE | `ComposerMode.tsx`, `compositionService.ts:77-121` | hide debug JSON |
| Article Writer | Durable run + review-ready preview | Yes | PARTIAL | `WriterPanel.tsx:808-826` | make output adoptable |
| Agent Controls | New-draft `content_write` job | Yes | COMPLETE | `AgentControls.tsx:7-8` | fine by design |
| Designer | Proposal-first, revision-bound apply | Yes | COMPLETE (editor) | `designerService.ts:451-496` | creation-mode apply gap |
| Editor | Block editor on `content_json` | Yes | COMPLETE | `EditorView.tsx`, `EditorMode.tsx` | giant component |
| Preview | Read-only canonical render | Yes | COMPLETE | `PreviewPane.tsx` | none |
| Knowledge | Overview/Sources/Search/Discovery/Add | Yes | COMPLETE | `components/knowledge/**` | none |
| Media | Generated + stock + provenance | Yes | COMPLETE | `MediaPanel.tsx` | none |
| SEO evaluation | Deterministic audit + opt-in AI | Yes | COMPLETE | `SeoPanel.tsx`, `contentIntelligenceService.ts` | none |
| Publishing | WordPress + X real; mock off | Yes | PARTIAL | `wordpress.ts`, `xPublisher.ts`; `config.ts:125` | only claim WP + X |
| Publications | Status tracking, live URL | Yes | COMPLETE | `Publications.tsx:222,238` | no traffic join |
| Scheduling | Create/reschedule/cancel, capability preflight | Yes | COMPLETE | `scheduleService.ts`, `ContentSchedule.tsx` | article/text intents only |
| Usage | Account + project aggregates | Yes | COMPLETE | `Usage.tsx`, `routes/usage.ts` | no cost/pricing |
| MCP / REST v1 | Content + jobs + schedules + designer | No (agent) | COMPLETE (internal) | `mcp/server.ts`, `v1.ts` | no Google/keyword exposure |

---

## 5. Google ecosystem assessment

One Google OAuth client, one signed-state handshake, one encrypted credential
store (`oauth.ts:46-135`, descriptors `oauthProviders.ts:55-96`, callbacks
`oauth.ts:138-153`). GSC, GA4 and Ads share this correctly. The divergence is at
the product layer.

### GSC — the integrated one

- Data source adapter with capabilities `['keywords','pages','performance']`
  (`gscDataSource.ts:96-100`); durable `gsc_sync` job (`executors.ts:144-203`,
  default 28 days `executors.ts:152`); persists to `seo_gsc_*` tables.
- Surfaces: project Dashboard stat cards + top queries (`Dashboard.tsx:77-84`,
  `:134-164`), Keywords "My keywords" (`Keywords.tsx:2126-2191`), account
  Overview dashboard with trends (`Overview.tsx:308-434`,
  `accountService.ts:379-494`), Settings property binding
  (`ProjectSettings.tsx:194-235`).
- Gaps: no period picker in UI (hardwired 28, `Keywords.tsx:2131`,
  `Overview.tsx:127`); country/device not synced (written empty,
  `keywordService.ts:8-10`); legacy project-scoped connect path still live
  (`integrations.ts:256-392`, `Integrations.tsx:62-217`) despite the
  account-only comment (`projectGsc.ts:43-58`).

### GA4 — thin but real

- Live client for Admin/Data API (`googleAnalyticsClient.ts`), service with
  periods `[7,28,90]` default 28 (`googleAnalyticsService.ts:48-49`); property
  binding `seo_project_analytics` (`20260101000033_google_analytics.sql`).
- UI: "Analytics" view, one table Page/Views/Users/Sessions with 7/28/90 buttons
  (`Analytics.tsx:18-102`); binding panel in Settings
  (`AnalyticsPropertyPanel.tsx`).
- Gaps: **traffic is never persisted** (query-time only), rows are path-only
  (`analytics.ts:32-41`) with no content key; no sync job; not in the provider
  catalog.

### Google Ads — thin but real, read-only

- Live client (`googleAdsClient.ts`), service with periods `[7,28,90]`
  (`googleAdsService.ts:52-53`), customer binding `seo_project_ads`
  (`20260101000037_google_ads.sql`).
- UI: "Paid search" view with Search terms and Keywords tables plus a filter
  (`AdsIntelligence.tsx:21-210`); binding panel `AdsCustomerPanel.tsx`.
- Read-only by construction (no mutate calls); scope `adwords` is Google's only
  Ads scope (`scopes.ts:4-10`).

### Coherence: one product or three tools?

Shared chassis (coherent): one OAuth client, one callback, identical
account-owned model, identical token keys and refresh-on-401, and consistent
project bindings (`seo_project_properties` / `seo_project_analytics` /
`seo_project_ads`).

Bolted-together signals:

- **Asymmetric depth.** GSC has sync, persistence, trends and an account
  dashboard; GA4/Ads are live single-table reads with no history or aggregate
  (`Analytics.tsx`, `AdsIntelligence.tsx`). Account Overview is GSC-only
  (`account.ts:511-538`).
- **Catalog invariant broken.** The UI is supposed to discover providers via the
  catalog and never hardcode a vendor (CLAUDE.md invariant 3), yet GA4/Ads are
  absent from the registry (`registry.ts:198-217`) and hardcoded into
  `AccountIntegrations.tsx:198-297`, while GSC is catalog-driven in
  `Integrations.tsx`.
- **Two GSC connect paths** (account-scoped and legacy project-scoped) coexist.
- **Inconsistent naming/periods.** Nav says "Paid search", code says "ads";
  GA4/Ads offer 7/28/90 while GSC is fixed.
- **No Google exposure through MCP or `/api/v1`** — "one brain, two mouths" does
  not yet cover the Google side.

Verdict: the backend is one Google model; the **product** is one mature tool
(GSC) plus two thin appendages. This is the clearest cross-cutting product-debt
theme.

---

## 6. Keyword intelligence assessment

The DataForSEO surface is the broadest in the app. All provider access is
isolated (`providers/dataforseo/{dataForSeoClient,dataSource,normalize}.ts`), and
work runs as durable jobs (`executors.ts:1066-1069`).

| Capability | State | Evidence |
| --- | --- | --- |
| Keyword input (single seed) | COMPLETE | `keywordResearch.ts:26-38`; `Keywords.tsx:248-259` |
| Keyword input (1–5 seeds, expansion) | COMPLETE | `keywordExpansion.ts:36-44`; `Keywords.tsx:924-934` |
| Search volume | COMPLETE | `normalize.ts:130`; `api.ts:1629`; `seoWriter.ts:294` |
| Difficulty | COMPLETE (inline only) | `normalize.ts:133,208`; dedicated client method unused (`dataForSeoClient.ts:476-494`) |
| CPC | COMPLETE | `normalize.ts:131,209`; `seoWriter.ts:296` |
| Suggestions | COMPLETE | `dataForSeoClient.ts:382-405`; `Keywords.tsx:752-756` |
| Related keywords | COMPLETE | `dataForSeoClient.ts:412-436` |
| Keyword ideas ("inspiration"-adjacent) | COMPLETE | `dataForSeoClient.ts:444-468` |
| Competitor discovery | COMPLETE | `dataForSeoClient.ts:503-521`; `executors.ts:443-464` |
| Domain intersection | PARTIAL | Always gap-oriented, `intersections:false` (`dataSource.ts:438-444`); no general A∩B query |
| Keyword gaps | COMPLETE | `dataSource.ts:422-456`; `executors.ts:467-507` |
| Opportunities | COMPLETE | `opportunityService.ts:189-220`; `Keywords.tsx:1192-1490` |
| Topics / core topics | COMPLETE | `opportunityTopicService.ts:285`; `Keywords.tsx:1787+` |
| Snapshots / history | PARTIAL | Upsert-in-place "current best known", not history (`seoWriter.ts:373-398`; `source_snapshots.sql:46`) |
| Selected competitors | COMPLETE (session) | `Keywords.tsx:2029`; not persisted |
| Ranking data (read) | BACKEND-ONLY | `seo.ts:204-224`; live UI shows a count only (`Dashboard.tsx:80`) |
| SERP results (read) | ABSENT | Write-only (`seoWriter.ts:434-456`); `getSerp` returns `[]` (`dataSource.ts:348-351`) |
| Google search inspiration | ABSENT | Zero code references; listed future in prior recon `architecture-product-debt-recon.md:740` |
| User-facing competitor keyword input | ABSENT | Competitors are domains only (`api.ts:1713-1719`; `competitorResearchService.ts:133-149`) |
| Saved keyword visibility | BROKEN/ORPHANED | `seo_keywords` read only by orphaned `Data.tsx`; live "My keywords" reads GSC (`Keywords.tsx:2031`) |

Notable specifics:

- `POST /jobs` is live but the only keyword/competitor caller is the orphaned
  `views/Data.tsx` (never imported; not in `App.tsx`).
- Orphaned read routes: `GET /performance`, `/keywords`, `/pages`, `/rankings`,
  `/audits` (`seo.ts:133-243`) have no live web caller.
- Dead provider code: `DataForSeoClient.keywordDifficulties`
  (`dataForSeoClient.ts:476-494`) and `DataForSeoDataSource.getCompetitors`
  (`dataSource.ts:359-379`).
- Honesty is preserved: metrics are nullable and rendered as dashes
  (`Keywords.tsx:326`); `site_audit` is hard-off (`seo.ts:125`).

**Competitor keywords / Google search inspiration (the previously flagged
plans):** neither is implemented; both are absent, not broken. Competitor
research exists but is **domain-seeded and gap-only**, and search inspiration
does not exist under any name. The "ideas" expansion method is the closest
existing analogue.

---

## 7. Content / workspace assessment

The R5 unified workspace is genuinely complete from a user perspective for the
editor path: one document session, autosave, selection, revision guards and
preview (`ProjectWorkspaceShell.tsx`, `workspaceSession.tsx:167-174`). Three
modes are exposed via the mode switcher: Composer, Designer, Editor
(`WorkspaceModeSwitcher.tsx:20-22`).

| Surface | State | Notes |
| --- | --- | --- |
| Workspace shell / modes | COMPLETE | `ProjectWorkspaceShell.tsx`; sidebar entry `App.tsx:106` |
| Document session / autosave | COMPLETE | `workspaceSession.tsx:167-174` |
| Editor | COMPLETE | `EditorView.tsx` (giant component) |
| Preview | COMPLETE | `PreviewPane.tsx` |
| Inline AI edit | COMPLETE | `contentAiEditService.ts:200-365`; two overlapping UI idioms |
| Composer | COMPLETE | `ComposerMode.tsx`, `compositionService.ts:77-121` |
| Designer | COMPLETE (editor) | `designerService.ts:451-496` |
| Knowledge panel | COMPLETE | `KnowledgePanel.tsx` |
| Media panel | COMPLETE | `MediaPanel.tsx` |
| SEO panel | COMPLETE | `SeoPanel.tsx` |
| Content Intelligence | COMPLETE | `IntelligencePanel.tsx` |
| Writer / Agent Controls | PARTIAL | see below |

Confirmed defects / gaps:

1. **Writer output is not adoptable.** The review result is explicitly
   preview-only: "this panel does not do that for you" (`WriterPanel.tsx:808-826`).
   A user can generate a review-ready draft and then has no one-click path to
   insert/replace it in the open document.
2. **Agent Controls always creates a new draft**, by design and by endpoint
   (`AgentControls.tsx:7-8`, `contentDraftService.ts:9-12`, always
   `contentId: null`). This is honest but means the "agent edits my article"
   mental model is not supported.
3. **Designer creation-mode proposals cannot be applied** because there is no
   content row (`Designer.tsx:599-621`); structural/image proposals are refused
   via the direct API as editor-only (`designerService.ts:462-482`).
4. **Writer free-text step is unwired by design** pending the durable Writer
   (`designerService.ts:11-14`).
5. **Composer exposes a raw JSON debug panel** (collapsed by default)
   `Compose.tsx:528-534`.

The R5 architecture itself is sound and should not be reopened. The gaps are
product-surface gaps (adoption), not architectural.

---

## 8. Publishing assessment

| Publisher | State | Evidence |
| --- | --- | --- |
| WordPress | REAL full lifecycle (create/update/delete) | `providers/wordpress.ts`; registry |
| X | REAL, text-only | `social/xPublisher.ts` (280-char preflight, token refresh); OAuth PKCE `social/xOAuth.ts` |
| mock_social | STUB, off by default | registered only when `ENABLE_TEST_PUBLISHERS=true`; `config.ts:125` |
| LinkedIn/Facebook/Instagram/TikTok | ABSENT | none registered |
| Media/image/video publisher | ABSENT | none registered |

- HTTP is enqueue-only (`routes/publications.ts`); executor dispatch
  `executors.ts:744`; status vocabulary
  `queued/publishing/published/failed/updated/deleted/scheduled`
  (`publicationService.ts:19`); retry/backoff `supabaseJobStore.ts:183`.
- Idempotency and attempt generation are real (`publicationJobs.ts`).
- Capability preflight before scheduling (`scheduleService.ts`); schedule UI
  limits intents to article/text (`ScheduleModal.tsx:35`).
- Error normalization is uniform (`publisherError.ts`).

UI honestly declares limits: Publishing "No publishers yet" (`Publishing.tsx:196`),
"Nothing published yet" (`:207`), Publications empty (`Publications.tsx:222`).
No UI claim contradicts the real capability set. **The only thing that looks
like a stub in the product story is social breadth:** X exists as a text
publisher only, and no other social provider is even represented, so the
"publish to social" story must stay limited to X text.

---

## 9. Measurement-loop assessment

Attempting the full loop create → publish → traffic → search → improve:

- **Create** works (workspace + agent).
- **Publish** works for WordPress (full lifecycle) and X (text).
- **Page traffic (GA4)** works as a live read (`projectAnalytics.ts:155-167`;
  `googleAnalyticsService.ts:279`) but is never persisted and is path-only with
  no content key (`analytics.ts:32-41`).
- **Search data (GSC)** works and persists (`executors.ts:144-203`).
- **Improve** has a real matcher: `contentIntelligenceService.ts` +
  `contentIntelligence.ts` (`contentPathKeys`/`pageUrlCandidates`) +
  `IntelligencePanel.tsx`.

Breakpoints that stop the loop from closing:

1. **No publication → traffic/search join.** `seo_publications.target_url`
   exists and is shown (`Publications.tsx:238`), but nothing reads it to link a
   published item to GA4 page rows or GSC page rows.
2. **GA4 is not stored.** No historical traffic table exists to join against.
3. **The editor does not set `url`.** Autosave sends title/status/content_json/
   target_keyword/meta fields only (`workspaceSession.tsx:167-174`); `url` is
   nullable (`20260101000003_seo_entities.sql:187`) and settable only via the
   API (`contentService.ts:185`), so content↔GSC matching usually rides on slug.
4. **GSC sync is not scheduled.** The only interval timer is stale-job recovery
   (`worker.ts:250`); sync is triggered manually or on attach.

Conclusion: the loop is **half-closed** — you can publish and, for GSC, observe
and match to content. GA4 traffic and the publication relationship are not part
of the loop. Automated optimization is explicitly not the objective here.

---

## 10. AI / agent assessment

Where AI is visible and what it does:

- **Editor inline AI** — selection-scoped edit producing a validated
  `replace_selection` block array; block/mark allowlists exclude image/link;
  never writes directly (`contentAiEditService.ts:200-365`).
- **Composer** — brief → plan → skeleton → AI slot fills; no persistence
  (`compositionService.ts:77-121`).
- **Writer / Agent Controls** — staged outline + writing pipeline with one
  corrective retry, best-effort knowledge context that never invents, persisted
  as `draft` through `ContentService.create` (`contentAgentService.ts:111-274`);
  Agent Controls starts a new draft only (`AgentControls.tsx:7-8`).
- **Designer** — proposal-first: `execute`/`executeIntent` never persist,
  `apply` re-reads content, rejects a revision mismatch with `stale_proposal`
  (409), then writes through `ContentService.update`
  (`designerService.ts:451-496`).
- **MCP tool semantics** — `content_generate` enqueues a durable job
  (`mcp/server.ts:298-319`); Designer tools are proposal-first and "there is no
  automatic apply and no publishing" (`mcp/server.ts:568-659`).

Product observations:

- The user-facing distinction between **ordinary editor AI** (inline AI edit)
  and an **agent** (durable, multi-step, proposal-first) is blurred: both live
  in the same right-hand rail, and the Writer/Agent Controls surfaces produce
  output that is not adoptable in place.
- The **MCP-only Designer server API does not matter to normal users**; it is
  internal/agent-facing infrastructure. The web Designer mode is the user
  surface.
- The UI does not clearly explain the "agent" concept (durable run, human
  approval, never auto-publish). The honesty copy is present in panels but not
  as a product concept.
- No speculative capability is claimed: unwired Writer free-text and
  creation-mode Designer apply are explicit, not fake.

---

## 11. Navigation assessment

Concrete observations:

- **Duplicated concepts.** "Integrations" exists at account (`App.tsx:94`) and
  project (`App.tsx:104`) scope with different backing surfaces
  (`AccountIntegrations.tsx` vs `Integrations.tsx`). "Usage" exists at both
  scopes, sharing one component (`Usage.tsx:9-21`). Account "Overview" vs
  project "Dashboard" are two landing summaries with different names.
- **Mobile dead end (critical).** The project sidebar is `hidden ... md:block`
  (`App.tsx:595`) with no mobile replacement; the only mobile project control is
  a project switcher that always navigates to `dashboard` (`App.tsx:556-573`).
  A phone user inside a project cannot reach Keywords, Analytics, Paid search,
  Knowledge, Workspace, Calendar, Publications, Publishing, Usage or Settings.
- **Workspace entry is clear** (sidebar "Workspace", `App.tsx:106`) once on
  desktop.
- **Retired routes are handled**: `content`/`compose`/`designer` redirect to
  `workspace` (`projectRoute.ts:108-117`, `App.tsx:409-411`).
- **Back navigation is OK**: top nav "Projects" is always present; unknown
  project renders "Project not found" with "Back to projects"
  (`App.tsx:351-356`). No breadcrumbs in project views.
- **Account vs project vs admin boundaries make sense**; admin is a separate
  trust boundary entered via header only (`App.tsx:543-555`) and provisioned
  out-of-band (`20260101000032_platform_admins.sql`).

The main IA problem is mobile reachability; the main conceptual problem is the
account/project duplication of Integrations and Usage without a stated rule for
which one is canonical.

---

## 12. Empty-state assessment

First-run: a user with no project gets `CreateProject` replacing the app
(`App.tsx:269-302`), with copy describing project isolation and account-level
GSC (`App.tsx:673-676`). After creation the user lands on the project dashboard.
There is **no product tour, checklist or progressive onboarding**, and the
account landing explains Google connection but not what the product does
end-to-end.

| Empty state | Tells what happened | Tells what next | Evidence |
| --- | --- | --- | --- |
| No projects | Yes (forced create) | Yes | `App.tsx:269-302` |
| Empty project dashboard | Yes | Partial (sources CTA) | `Dashboard.tsx:119-120` |
| No GSC connected | Yes | Yes (connect CTA) | `Overview.tsx:163,223-248`; `Keywords.tsx:2160-2164` |
| No GSC data | Yes | Yes (run sync) | `Keywords.tsx:2166-2177` |
| No GA4 property | Yes | Yes (open settings) | `Analytics.tsx:65-75` |
| No Ads customer | Yes | Yes (open settings) | `AdsIntelligence.tsx:112-122` |
| No keywords | Yes (results empty) | Partial | `Keywords.tsx` result empties |
| No content | Yes ("No content yet") | Partial | `EditorView.tsx:388` |
| No publications | Yes | Partial | `Publications.tsx:222` |
| No publishers | Yes | Yes | `Publishing.tsx:196` |
| No traffic | Yes | Partial | `Analytics.tsx:76-77` |
| No account properties | Yes | Yes | `AccountIntegrations.tsx:399` |

The honesty pattern (no fabricated zeros) holds; the gap is **guidance depth**:
several empty states state the fact but not a concrete next step, and there is
no single "get to first value" path connecting Google → keyword → article →
publish → measure.

---

## 13. Mobile / visual assessment

Intended direction: simple, chunky, readable, ~2010 web-era language,
understandable at smartphone resolution.

- **Contradiction (critical):** no mobile project navigation (see §11).
- **Density:** `Keywords.tsx` is ~2,194 lines with seven tabs
  (`Keywords.tsx:2017-2024`); `App.tsx` is 892 lines; `WriterPanel.tsx` is 1,508
  lines. These are dense at phone width even with horizontal table scroll
  (`components/ui/table.tsx:7`).
- **Technical surfaces exposed:** raw JSON debug in Composer
  (`Compose.tsx:528-534`); monospaced technical values in Settings
  (`ProjectSettings.tsx:163`).
- **Top nav on mobile is icon-only** (`App.tsx:538`) and the app name is hidden
  (`App.tsx:522`); labels are unavailable, which is acceptable for 5 icons but
  robs discoverability of the project views (which have no icons-only bar).
- **Terminology is inconsistent:** "Overview" vs "Dashboard"; "Paid search" vs
  "Ads"/"Google Ads"; provider capability vs vendor naming.

No redesign is proposed. The mobile navigation gap is the only item here that is
a functional failure rather than polish.

---

## 14. Product debt

Something works but the user cannot use it effectively.

1. **Mobile project navigation absent** (`App.tsx:595`). Desktop-only product on
   an app explicitly intended to be smartphone-readable.
2. **Writer output not adoptable in place** (`WriterPanel.tsx:808-826`). The
   agent produces value the user must manually retype/copy.
3. **Designer creation-mode proposals cannot be applied** (`Designer.tsx:599-621`).
4. **Google coherence:** GA4/Ads hardcoded outside the catalog
   (`AccountIntegrations.tsx:198-297`); GSC has no period picker while GA4/Ads do;
   account Overview is GSC-only (`account.ts:511-538`).
5. **Research results not retained as a surface:** saved `seo_keywords` are only
   read by the orphaned `Data.tsx`; live "My keywords" reads GSC
   (`Keywords.tsx:2031`). Users cannot see their own research history after a
   run.
6. **Competitor selection is session-only** (`Keywords.tsx:2029`).
7. **Snapshots are "current best known", not history** (`seoWriter.ts:373-398`).
8. **Composer debug JSON exposed** (`Compose.tsx:528-534`).
9. **Two overlapping inline-AI idioms** in the editor rail.
10. **No onboarding path to first value**; return users get no guided next step.

## 15. Technical debt

The product works; the implementation is fragile or duplicated.

1. **Worker/job registry split and bypass** — three registries
   (`enqueue.ts:17-31`, `executors.ts:1065-1085`, `worker.ts:207`), 10 executed
   types missing from `JOB_PROVIDER`, and direct `jobStore.enqueue` calls that
   bypass the shared gate (e.g. `v1.ts:178`, `mcp/server.ts:316,350`).
2. **Cancellation is ineffective** — `cancel` sets `canceled` regardless of
   state (`supabaseJobStore.ts:217-222`), executors never check it, and terminal
   writes are unconditional (`worker.ts:153`). The route comment admits this
   (`routes/jobs.ts:80-82`).
3. **Parallel job lifecycles** — `AgentRunService` and `WriterRunService`
   (no `JobStore`) alongside `seo_sync_jobs` (`writerRunService.ts`).
4. **Legacy project-scoped GSC path** coexists with the account-scoped path
   (`integrations.ts:256-392`; `projectGsc.ts:43-58`).
5. **Orphaned code** — `views/Data.tsx` (not imported); read routes
   `/performance`, `/keywords`, `/pages`, `/rankings`, `/audits` (`seo.ts:133-243`);
   dead provider methods (`dataForSeoClient.ts:476-494`,
   `dataSource.ts:359-379`).
6. **Giant components** — `Keywords.tsx` (~2,194), `EditorView.tsx`,
   `WriterPanel.tsx` (1,508), `App.tsx` (892).
7. **Provider-catalog divergence** — GA4/Ads are not registry providers, so the
   catalog invariant (#3) is bypassed for two of the four Google-family
   surfaces.
8. **Frontend DTO duplication** of `/providers` and account analytics, as noted
   in the prior recon (`architecture-product-debt-recon.md:640-642`).
9. **No MCP/v1 exposure** for Google or keyword/competitor capabilities.

Per §22 of the brief, the worker defects do not currently block user-visible
features, P6 candidates, or launch, and are therefore classified as technical
debt, not immediate product work — but they become the failure mode if a fourth
job type cluster is added without unification.

## 16. Feature gaps

The capability simply does not exist.

1. **Google search inspiration** — absent everywhere (prior recon lists it as
   future, `architecture-product-debt-recon.md:740`).
2. **User-facing competitor keyword input** — competitors are domain-seeded and
   gap-only (`api.ts:1713-1719`).
3. **Ranking / SERP read UI** — `/rankings` exists backend-only (`seo.ts:204-224`);
   `seo_serp_results` is write-only (`seoWriter.ts:434-456`); `getSerp` returns
   `[]` (`dataSource.ts:348-351`).
4. **Persisted GA4 traffic and publication→traffic join** — no table, no key
   (`analytics.ts:32-41`; `seo_publications.target_url` unread).
5. **Scheduled/recurring GSC sync** — manual only (`worker.ts:250`).
6. **Site audit / crawler** — not registered; dashboard reports
   `site_audit:false` (`seo.ts:125`).
7. **Media/social publishers** — no image/video publisher; no social providers
   beyond X.
8. **Account member management / project API-key UI** — route exists
   (`app.ts:222`) but no web view; account keys are UI-managed only.
9. **Cost/pricing in usage** — aggregates only (`routes/usage.ts`; `Usage.tsx:31-32`).

## 17. Intentional deferrals

Deliberately outside current scope, not defects.

- **Social publishers** (LinkedIn/Facebook/Instagram/TikTok) — roadmap §9,
  capability-only later (`roadmap.md:149-154`).
- **Landing page / marketing surface** — explicitly excluded by this brief.
- **Account-scope publishing** and collapse of the three-way credentials owner
  — prior recon LATER (`architecture-product-debt-recon.md:775-776`).
- **Legacy `seo_content` column removal** — deferred until consumers verified
  (`architecture-product-debt-recon.md:777`).
- **Crawl/audit engine** — non-goal (`roadmap.md:184`).
- **DesignPackage runtime** — deferred (`architecture-product-debt-recon.md:787`).
- **Automated SEO optimization** — explicitly not the objective of the
  measurement loop (this brief §9).
- **Writer free-text step** and **Designer structural/image direct-apply** —
  intentionally unavailable pending the durable Writer / editor-only flow
  (`designerService.ts:11-14,462-482`).

## 18. Landing-page truth table

What can be honestly promised today, mapped to the conceptual visual.

| Concept arrow | Real today? | Evidence / limit |
| --- | --- | --- |
| Google → Search (GSC) | REAL | Persisted sync, dashboard, trends |
| Google → Analytics (GA4) | REAL but thin | Live page traffic only; no history |
| Google → Ads | REAL but thin | Read-only search terms/keywords; no story beyond a table |
| Google → SEO Toverdoos | PARTIAL | The three products do not yet read as one tool |
| → Article Writer | PARTIAL | Produces a review-ready draft; not adoptable in place |
| → Designer / Editor | REAL | Composer/Designer/Editor/Preview; Designer creation apply gap |
| → WordPress / X | REAL | WP full lifecycle; X text-only |
| → Google reads (↺) | PARTIAL | GSC content intelligence matches content; GA4/publication join missing |

Honest claim surface: **connect Google, research keywords and competitors,
observe Search Console performance, write and design content with AI, preview
it, and publish to WordPress or X.** Do not claim: automated optimization, a
closed analytics feedback loop, social breadth beyond X, competitor-keyword or
search-inspiration inputs, or ranking/SERP dashboards.

## 19. Launch-critical items

An item is here only if its absence creates a concrete product failure.

1. **Mobile project navigation.** Concrete failure: on a phone, a user inside a
   project cannot navigate to 9 of 12 project views (`App.tsx:595`). Dependency:
   none; additive.
2. **An obvious path to first value.** Concrete failure: a new user creates a
   project and reaches a dashboard with no guided sequence connecting Google →
   keyword → article → publish. Dependency: needs the mobile/IA fixes to place
   the guidance.
3. **Agent output adoption (Writer, and Designer creation).** Concrete failure:
   the headline AI promises produce output the user cannot put into the
   document (`WriterPanel.tsx:808-826`; `Designer.tsx:599-621`). Dependency:
   a deliberate insertion/replace contract into the existing revision-guarded
   apply.
4. **One coherent Google surface with a consistent observation model.**
   Concrete failure: a paying user connecting "Google" gets three disconnected
   experiences with different periods and no shared dashboard; GSC has no
   period control at all. Dependency: period picker + catalog registration +
   account dashboard decision.

## 20. Post-launch items

- Persist GA4 traffic and join publications to traffic/search (measurement-loop
  closure).
- Surface saved keywords / research history as a first-class list.
- Persist competitor selection.
- Scheduled GSC sync.
- Social provider breadth (LinkedIn/Facebook/Instagram/TikTok).
- Media/social publisher for image/video.
- Cost/pricing in usage.
- Account member management and project API-key UI.
- Ranking/SERP read UI.
- Component splitting and orphan cleanup.

## 21. Cheap-now / expensive-later items

Work where postponing causes rework. None requires a schema redesign.

1. **Add a publication/content join key before persisting GA4 traffic.** If GA4
   history is stored path-only (`analytics.ts:32-41`) and later a content key is
   needed, the stored history cannot be backfilled. Cheap now: decide the key
   (`content_id` and/or normalized URL) as part of the GA4 persistence design.
2. **Set `url` from the editor.** Content↔GSC matching currently depends on slug
   because autosave omits `url` (`workspaceSession.tsx:167-174`). Adding it now
   avoids a matching-quality migration later.
3. **Unify the job-type gate before adding any new job type cluster.** The
   prior recon names a fourth registry as the likely failure mode
   (`architecture-product-debt-recon.md:631-633`); Google/keyword expansions
   would each add types.
4. **Register GA4/Ads as providers (or consciously bless the bespoke path).**
   Every new Google product today copies the hardcoded account card; a decision
   now prevents a third bespoke integration.
5. **Normalize the observation model (period constants + shared DTOs).** GA4/Ads
   already share `[7,28,90]`; GSC does not. Doing this once, now, avoids three
   implementations of the same control.
6. **Finish the legacy GSC retirement** before adding more Google bindings, so
   the account-scoped model is the only one.

## 22. Candidate next phases

Derived from the findings; not a predetermined roadmap.

1. **P6a — Product UX completion (recommended first):** mobile project
   navigation, first-value guidance/onboarding, Writer adoption, Designer
   creation apply, period picker + catalog registration for Google, hide
   Composer debug JSON.
2. **P6b — Keyword/competitor workflow completion:** surface saved
   `seo_keywords` (retire the orphaned Data path), persist competitor selection,
   and — only if deliberately chosen — add competitor-keyword and search
   inspiration inputs. (Implementing those two inputs is excluded from this
   phase.)
3. **P7 — SEO intelligence dashboard / measurement loop:** persist GA4 traffic,
   add the publication→content→traffic/search join, scheduled GSC sync, and a
   unified Google view.
4. **Worker architecture unification:** unify the three job registries, route
   every enqueue through one gate, make cancellation effective. Do this before
   scaling job types, not as a standalone product phase.
5. **Landing / marketing surface:** use §18 to constrain claims.
6. **Post-launch expansion:** social breadth, media publishing, cost/pricing,
   account/project admin UI, ranking/SERP UI.

## 23. Explicit non-goals

Per this brief, and confirmed as not implemented: competitor keyword input,
Google search inspiration input, new Google integrations, campaign management,
new social publishing providers, the landing page, visual redesign, worker
registry refactor, and speculative AI features. Nothing in this recon should be
read as authorizing any of those.

---

## 24. Final recommendation

Do not build new providers next. The product already has enough real capability
to demo an honest end-to-end story. The gap between "impressive backend" and
"credible product" is concentrated in four user-facing areas: **mobile
navigation, first-value guidance, agent output adoption, and Google
coherence** — plus one deliberate decision about how far the measurement loop
must close before launch.

If one phase is chosen, it should be **product UX completion (P6a)**, followed
by the **measurement-loop closure (P7)**. Keyword/competitor input expansion
(P6b) is a genuine capability opportunity but is not launch-critical and is
partly excluded by this brief. Worker unification should be scheduled as an
enabler immediately before any new job-type cluster, not as product work.

### What is already a real product?

A project-scoped desktop SEO workbench: Google login and projects with roles;
GSC connection, ingestion and dashboards; DataForSEO keyword, expansion,
competitor-gap, opportunity and topic workflows; a multi-mode AI content
workspace (Composer/Designer/Editor/Preview) with a knowledge base and media;
WordPress (full lifecycle) and X (text) publishing with honest status tracking;
usage metering; platform admin. All data paths are real or honestly
not-configured.

### What is merely infrastructure?

The MCP servers and `/api/v1` agent API; the provider catalog; the platform
admin area; the usage ledger internals; the durable job queue and worker; the
Designer MCP server API; the source-snapshot store. These are real and valuable
but not user-facing product, and none of them yet exposes the Google or keyword
capabilities.

### What is still missing?

A closed measurement loop (GA4 persistence + publication→traffic/search join +
scheduled GSC sync); mobile project navigation; first-value onboarding; agent
output adoption (Writer, Designer creation); competitor-keyword and Google
search-inspiration inputs; ranking/SERP read surfaces; a coherent single Google
surface; social breadth; cost/pricing.

### What would actually prevent a credible first release?

The mobile project-navigation dead end; AI agent surfaces that produce output
the user cannot adopt; and a Google experience that reads as three disconnected
tools rather than one product. None of these is an architectural blocker; all
are user-facing product gaps.

### What should we build next?

Product UX completion: mobile project navigation, first-value guidance, Writer
(and Designer creation) adoption, and Google coherence (period control, catalog
registration, account dashboard decision). Then persist GA4 traffic and join
publications to their traffic and search rows.

### What should we deliberately NOT build yet?

The landing page and visual redesign; competitor-keyword and search-inspiration
inputs; new Google integrations or campaign management; additional social
publishers; a standalone worker-registry refactor (except as an enabler before
new job types); and speculative AI optimization. The measurement loop must stay
human-in-the-loop; automated optimization is explicitly out of scope.

---

## Verification

- Baseline: commit `3114f27` (P5 Google Ads). Validated this session:
  `pnpm test` (API + web) green, `pnpm lint` 0 errors, `pnpm build` green,
  `scripts/db-migrate-local.sh` green on a fresh database.
- This recon introduced **documentation only**. No application, schema, test or
  dependency changes.
- Expected changed files: `docs/p6-product-completion-recon.md` (new).
- `git diff --check` to be run before commit; application behavior change:
  **NONE**.
