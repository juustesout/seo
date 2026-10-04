# Post-P7 Product Completion Recon

Baseline: `639af95 feat(measurement): close the P7 content measurement loop`.

This is a product reconnaissance, not an architecture audit. It answers one
question:

> If we stopped adding major infrastructure today, what would still prevent us
> from putting Old Skool SEO in front of a real user?

Findings are classified **A** launch blocker, **B** important product gap,
**C** product polish, **D** useful future feature, **E** technical debt,
**F** operational improvement, **G** explicitly unnecessary.

No code, migration, contract, test or configuration was changed to produce this
document.

---

## 1. Executive summary

The product is substantially complete. The full real-world loop exists in the
application today:

```text
sign in -> create project -> connect Google -> research -> choose opportunity
-> create draft -> edit (Writer/Composer/Designer) -> publish -> measure
-> return to research
```

The P7 measurement loop genuinely closes: a publication row carries the live
URL, GA4 page traffic is persisted, GSC and GA4 are joined to a content item,
and the Performance screen explains what was measured and what was not.

There is **no confirmed hard launch blocker in the application logic**, but
there is **one signup/OTP integration risk that must be verified against the
live Supabase project before release** (Section 5), plus **one permanently
dark data source** (the GSC page-signal path in content intelligence, Section 6
and 15) that is a real product defect. Beyond that, the remaining work is
polish, a small number of trust/handoff fixes, and release preparation.

Stop-building verdict (Section 20): **yes, with specific polish**.

Recommended next phase (Section 22): **B. Product polish**, followed directly
by **F. Release preparation** — not another feature phase.

---

## 2. Current product baseline

Already delivered and treated as the baseline (not re-audited):
authentication (email/password, Google OAuth, magic link/OTP,
`apps/web/src/App.tsx:844-909`); projects, navigation and onboarding; the
unified Google hub (GSC, GA4, Ads); keyword and competitor intelligence;
AI Writer, Composer, Designer, Editor, Preview and Knowledge Base; WordPress
and X publishing; usage; and project/platform administration.

P7 added durable GA4 page traffic, publication identity, the content-to-URL
relationship, GSC/GA4 joining, the content performance API, the Performance UI
and explicit measurement sync.

The P7 surfaces are present and wired:
`apps/web/src/views/Performance.tsx`, `apps/web/src/lib/performance.ts`,
`apps/api/src/services/contentPerformanceService.ts`,
`apps/api/src/http/routes/projectPerformance.ts`.

---

## 3. End-to-end product journey

| Transition | Exists | Works | Discoverable | Next action clear | Dead end | Trustworthy |
| --- | --- | --- | --- | --- | --- | --- |
| New user -> login/signup | yes | mostly | yes | mostly | no | signup OTP risk (Sec. 5) |
| Login -> project | yes | yes | yes | yes | no | yes |
| Create project -> project opens | yes | yes | yes | yes | no | yes |
| Understand what to do | yes | yes | yes | yes | no | onboarding (Sec. 11, 13) |
| Connect Google | yes | yes | yes | yes | no | partial (Sec. 5) |
| Research | yes | yes | yes | yes | no | results ephemeral (Sec. 6) |
| Choose opportunity -> create draft | yes | yes | yes | banner only | soft (Sec. 6, 12) | yes |
| Create article -> workspace | yes | yes | via list | yes | no | yes |
| AI assistance | yes | yes | yes | yes | no | explicit apply only |
| Edit | yes | yes | yes | yes | no | yes |
| Publish | yes | yes | yes | yes | no | no content link (Sec. 8) |
| Measure | yes | yes | yes | yes | no | partial states (Sec. 9) |
| Understand result | yes | yes | yes | yes | no | yes |
| Improve next article | yes | manual | yes | yes | no | yes |

The chain is unbroken in code. The soft spots are the research-to-draft
hand-off (a banner, not a navigation) and the publish-to-content linkage.

---

## 4. Product surface inventory

| Surface | Real capability | User usable | Current gap | Class | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Auth | password, Google, magic link/OTP | yes | no password reset; signup OTP type risk | B/A | verify OTP; add reset |
| Projects | create, select | yes | no rename/delete/update | B | add minimal update/delete |
| Google | hub for GSC/GA4/Ads | yes | copy contradiction; partial-failure collapse | C | fix copy + per-product error |
| GSC | connect, attach property, queries | yes | none material | C | - |
| GA4 | connect, property, traffic | yes | none material | C | - |
| Ads | connect, customer, paid terms | yes | none material | C | - |
| Research | keyword/competitor/gap/expand | yes | live results ephemeral | C | persist last run |
| Competitors | discovery, compare, gap | yes | no direct keyword input | D (optional) | defer |
| Writer | plan + draft + SEO score | yes | hand-off is explicit "Use article" | C | keep; surface more clearly |
| Workspace | content list + editor + modes | yes | content list only inside Editor | C | consider entry from research |
| Knowledge | sources, search, discover | yes | none material | C | - |
| Publishing | WordPress/X, composer, jobs | yes | composer sends no `content_id` | B | link publication to content |
| Performance | totals, per-article, sync | yes | only measured/no-data states | B/C | richer honest states |
| Usage | read-only consumption | yes | counts only (by design) | F | keep; billing later |
| Admin | users/accounts/projects/usage | yes | revoke/delete unconfirmed | C | add confirmations |

---

## 5. Google assessment

The unified hub works as a product. `apps/web/src/views/Google.tsx:123-158`
renders three cards with plain-language descriptions:

- Search Console -> "Organic queries and clicks your site is seen for."
- Analytics -> "Which pages actually receive traffic (GA4)."
- Ads -> "Search terms and keywords receiving paid traffic."

This is the intended outcome (GSC = organic, GA4 = traffic, Ads = paid). Each
card has a connect/configure/open action and shows the currently selected
property/customer (`Google.tsx:126-127, 138-139, 150-151`).

Two concrete problems:

1. **Copy contradiction.** The hub header states *"One Google authorization per
   account."* (`Google.tsx:112`), but the implementation uses separate
   account-scoped OAuth grants with distinct callbacks and scopes
   (`apps/api/src/providers/google/oauthProviders.ts:70-90`), and the account
   screen describes Analytics/Ads as separately authorized. A user who reads
   "one authorization" and then is asked to authorize three times loses trust.
   Class **C**.

2. **Partial failure collapses the whole hub.** `Google.tsx:106` computes
   `errored = gsc.error || analytics.error || ads.error` and `Google.tsx:117`
   then replaces all three product cards with a single generic error. One
   failed read hides two healthy integrations. Class **C** (verging on B for a
   multi-product account).

Property/customer selection itself is clear: `ProjectSettings.tsx` attaches a
GSC property (`ProjectSettings.tsx:192-302`) and `AnalyticsPropertyPanel` /
`AdsCustomerPanel` handle GA4 and Ads selection. The account-vs-project split
is explained on screen (`ProjectSettings.tsx:141`).

---

## 6. Research assessment

The research product is usable without the deferred features.

`apps/web/src/views/Keywords.tsx:2018-2026` defines seven tabs: **My keywords,
Research, Expand, Competitors, Compare, Opportunities, Topics**. Together these
cover the workflow "enter a topic -> get data -> discover opportunities ->
understand competition -> choose something to write".

```
My keywords  -> GSC queries already ranking (Keywords.tsx:2131+)
Research     -> DataForSEO volume/difficulty/CPC for one seed (Keywords.tsx:242+)
Expand       -> related/suggested/idea keywords, review then save (Keywords.tsx:760+)
Competitors  -> discovery + page-one gap analysis (Keywords.tsx:354+)
Compare      -> competitor intersection view
Opportunities-> explainable scored opportunities (Keywords.tsx:1252+)
Topics       -> actionable topics matched to core topics + knowledge base (Keywords.tsx:1818+)
```

Findings:

- **Live research runs are ephemeral.** Keyword and competitor runs are held in
  component state and read back by job id (`Keywords.tsx:170-180, 303-327`);
  navigating away loses the view. Competitor results persist as source snapshots
  (KW4.5, `Keywords.tsx:356`) and Expand saves selected keywords
  (`Keywords.tsx:879-893`), so exploratory research is honest but not resumable.
  Class **C**.
- **Opportunity/Topic -> article is a banner, not a hand-off.** "Create article"
  enqueues a server-side draft job and shows `Draft generation started ... Follow
  it in Content.` (`Keywords.tsx:1252-1273`, `1818-1834`) with no navigation to
  the draft and a reference to "Content" — a label that no longer exists (the
  surface is **Workspace**, Section 12). The draft does appear in the Workspace
  content list (`EditorView.tsx:440-484`) once the job finishes. Class **C**
  (discoverability), not a hard dead end.

**Competitor keyword input** — classification: **optional / useful**. The
domain-based competitor flow already produces page-one gap data and scored
opportunities (`Keywords.tsx:1252`), which is enough to choose something to
write. Direct keyword input is a convenience over an existing capability, not a
prerequisite. It does not fail the current product if absent.

**Google search inspiration** — classification: **optional / useful future**.
DataForSEO keyword research plus expansion (`Keywords.tsx:242+, 760+`) already
supplies inspiration from real search data. Its absence does not create a
product gap for the initial release.

**Competitor workflow** is understandable: competitors are entered in the
Competitors tab, discovery is useful, gaps are actionable, and opportunities
and topics lead to content creation.

---

## 7. Content / AI assessment

The hand-off from SEO insight to finished editable content is clean after P6a.

- The unified workspace shell owns one document session across Editor, Composer
  and Designer (`apps/web/src/workspace/ProjectWorkspaceShell.tsx`,
  `WorkspaceModeSwitcher`); the content list lives inside Editor mode with a
  "New article title..." form and a content table (`EditorView.tsx:395-484`).
- **Writer -> workspace is explicit and honest.** The AI Writer produces a
  review-ready draft that is *not* saved or published
  (`apps/web/src/components/content/WriterPanel.tsx:799-819`). The user adopts it
  with **Use article** (`WriterPanel.tsx:833-841`), which loads it into the open
  draft and lets autosave persist it (`WriterPanel.tsx:838-840`).
- **AI value is tangible.** In-editor actions (`ContentAiPanel`,
  `ContentAiEditPanel`), the Writer plan/draft/revision cycle, and deterministic
  SEO evaluation (`WriterPanel.tsx:813-828`) all produce output that enters the
  document only on explicit user action. Nothing auto-applies or auto-publishes
  (`WriterPanel.tsx:817`).
- **SEO/quality feedback before publishing** exists: `SeoPanel`, the
  deterministic SEO score and checks (`WriterPanel.tsx:813-828`), the Knowledge
  Base (`apps/web/src/views/Knowledge.tsx`), and media/insert tooling. A user can
  reasonably decide "this article is ready to publish".

No concrete problem requires an autonomous agent. The agent-like surfaces are
useful, not theatrical, and remain human-driven.

One minor polish item: the Writer's adoption affordance ("Use article") is the
key bridge between AI output and the document, and it sits below the preview
(`WriterPanel.tsx:833`); it is not hard to find but it is the single most
important action in the panel and could be made more prominent. Class **C**.

---

## 8. Publishing assessment

Publishing is wired end to end for WordPress and X.

- The Publishing screen connects channels, lists publications and shows publish
  jobs (`apps/web/src/views/Publishing.tsx:164-255`).
- The Publications screen shows status, the live `target_url`, and real failure
  errors as-is (`apps/web/src/views/Publications.tsx:251-258, 342-386`).
- The worker writes `target_url`/`remote_id` only after the provider confirms
  (`apps/api/src/jobs/executors.ts:855, 887`), so the captured URL is real, not
  optimistic.

One important gap:

- **The direct composer does not link the publication to a content item.** The
  composer posts `{ publisher_id, publish_kind, title, content, excerpt,
  remote_status }` (`apps/web/src/views/Publishing.tsx:509-518`) with no
  `content_id`. As a result a publication created from the composer is not tied
  to a `seo_content` row, and publishing does not set `seo_content.status`.
  (Status is changed separately via the document header's Status control,
  `apps/web/src/components/content/workspace/DocumentHeader.tsx:74, 175-220`.)
  This weakens the "publish from the editor" story and the content-performance
  join input. Class **B**.

Publishing does feel like the natural final step for content that originates in
the workspace; the gap is that the standalone composer is a parallel path that
does not close the loop.

---

## 9. Measurement assessment

The P7 loop is real and honest, with two limiters.

What works:

- Performance is a first-class nav item (`apps/web/src/App.tsx:107`) showing
  Search and Traffic totals with clear labels and per-article
  clicks/impressions/position/views/users and `days_live`
  (`apps/web/src/views/Performance.tsx:100-121, 161-205`).
- It surfaces freshness (`last synced`, `Performance.tsx:145`) and honest notes
  such as "Connect Search Console..." / "Bind a Google Analytics property..."
  (`apps/api/src/services/contentPerformanceService.ts:154-155`;
  `Performance.tsx:124-137`).
- Explicit sync is discoverable via the "Sync data" button
  (`Performance.tsx:88-92`) with a banner explaining what started
  (`Performance.tsx:55-69`). The absence of a scheduler is intentional, not a
  defect.

What is limited:

1. **The state vocabulary is only two values.** The contract defines
   `ContentPerformanceState = 'measured' | 'no_traffic'`
   (`packages/contracts/src/performance.ts:36-41`), and the UI renders a
   `Measured` / `No data` badge (`Performance.tsx:197-200`). The product cannot
   distinguish "published but not indexed", "no matching page in GSC/GA4", or
   "not configured" from "indexed with zero traffic". Not-configured is
   partially covered by notes, but not-indexed and no-matching-page are not.
   This is a **trust** issue, not merely technical. Class **B/C**.

2. **A GSC page-signal source is permanently dark.** The content intelligence
   path still queries `seo_gsc_properties` by `project_id`
   (`apps/api/src/services/contentIntelligenceService.ts:251-256`), but that
   column was dropped when the registry became account-scoped
   (`supabase/migrations/20260101000012_property_registry.sql:104-106`), so the
   query errors, the code degrades, and the GSC source is reported unavailable
   with the note "Search Console properties could not be read, so page signals
   are unavailable right now." (`contentIntelligenceService.ts:257-259`). Every
   content intelligence view loses its GSC page signals. Class **B**.

The article connects naturally to performance (row keyed by `content_id`,
`Performance.tsx:175-176`), and seeing measured results is a legitimate reason
to write the next article.

---

## 10. Mobile assessment

P6a fixed the launch-critical navigation problem. The remaining issues are
concrete but not blockers.

- Mobile project navigation exists and is reachable (`apps/web/src/App.tsx:405-411`).
- The account/project header is dense on narrow viewports (crowding, not lost
  controls). Class **C**.
- Dense tables are the main risk: Performance has eight columns
  (`Performance.tsx:162-172`), and the content/keyword tables are multi-column,
  requiring horizontal scrolling on phones. Class **C**.
- The workspace is usable on mobile: single-column canvas, Editor/Preview toggle
  and a preview viewport (`ProjectWorkspaceShell`, `PreviewPane`).

No inaccessible control or broken dialog was found that blocks the critical
workflow.

---

## 11. Empty-state assessment

| Empty state | Handled | Next action clear |
| --- | --- | --- |
| No projects | yes (`Overview.tsx:210`) | yes |
| Empty project | yes (onboarding checklist) | yes |
| No Google connections | yes (cards show connect) | yes |
| No Google data (GSC/GA4/Ads) | partial | partial |
| No keywords | yes | yes |
| No opportunities | yes (hint to go to Competitors, `Keywords.tsx:2111`) | yes |
| No content | yes (`EditorView.tsx:438`) | yes |
| No publication | yes (`Publishing.tsx:207`) | yes |
| No traffic | yes via notes (`Performance.tsx:124-137`) | yes |
| No search performance | yes via notes | yes |

Strengths: content, publishing, performance and usage all state what happened
and what to do next (`Performance.tsx:157-158`, `Publishing.tsx:196,207`,
`apps/web/src/views/Usage.tsx:40`). Weakness: the Google product empty states
are status pills with a connect action but little explanation of prerequisites.
Class **C**.

---

## 12. Navigation assessment

`apps/web/src/App.tsx:95-115`:

- Account nav: Overview, Projects, Integrations, API keys, Usage.
- Project nav: Dashboard, Keywords, Google, Performance, Integrations,
  Knowledge Base, Workspace, Calendar, Publications, Publishing, Usage,
  Settings.

Findings:

- **Duplicate label.** "Integrations" appears in both the account nav
  (`App.tsx:98`) and the project nav (`App.tsx:108`), with different meanings
  (account connections vs project configuration). Class **C**.
- **Stale destination copy.** Keywords tells users to "Follow it in Content"
  (`Keywords.tsx:1273, 1834`) but there is no "Content" nav item; content lives
  under **Workspace**. Class **C**.
- **Orphaned screen.** `apps/web/src/views/Data.tsx` is not imported anywhere.
  Class **E** (safe to defer, ideally remove).
- **Retired routes redirect cleanly** to the workspace (`App.tsx:205, 376,
  448-450`), and no buried critical function was found: Performance, the Google
  hub and Publishing are all top-level.

No navigation redesign is warranted; only the duplicate label and stale copy
need attention.

---

## 13. Administration assessment

Administration is sufficient for initial operation.

- Account: integrations and API keys (`apps/web/src/views/AccountIntegrations.tsx`,
  `apps/web/src/views/AccountApiKeys.tsx`).
- BYOK: the account integrations screen hosts the user's OpenAI key
  (`AccountIntegrations.tsx:303`), stored encrypted server-side; the codebase
  reads user-oriented env names (`USER_LLM_API_KEY` and equivalents), not agent
  runtime variables.
- Project: members, Cosmos/brand guidance, GSC property, GA4 property and Ads
  customer all live under Settings (`apps/web/src/views/ProjectSettings.tsx:114-120`).
- Platform admin: `apps/web/src/views/admin/AdminArea.tsx` exposes
  Overview/Users/Accounts/Projects/Usage and is gated by `isAdmin` (`AdminArea.tsx:52`).

Concrete issues:

- **No project rename/delete/update.** Only `seo_create_project`
  (`supabase/migrations/20260101000006_rls.sql:316`) and
  `seo_update_project_member_role` (`...:406`) exist. A mistyped or obsolete
  project cannot be fixed or removed by its owner. Class **B** (mild).
- **Destructive actions lack confirmation.** API key Revoke
  (`AccountApiKeys.tsx:242-251`) and integration Delete
  (`apps/web/src/views/Integrations.tsx:291-299`) act immediately. Class **C**.

Nothing here prevents a real user from operating the product.

---

## 14. Operational assessment

- **Failed jobs are unreadable in the shared jobs table.** `seo_sync_jobs.error`
  is `jsonb` (`supabase/migrations/20260101000005_jobs_publishing.sql:22`) and
  `JobError` is an object (`packages/contracts/src/models.ts:498-507`); the
  generic `JobTable` renders it directly as `` `error: ${j.error}` ``
  (`apps/web/src/lib/ui.tsx:174`), printing `error: [object Object]`. The table is
  used in Dashboard, Publishing, Data and Knowledge; some callers read
  `error?.message` correctly (`Keywords.tsx:2049`) but the shared component does
  not. Class **B/F** (operational readability).
- **Explicit measurement sync** is the intentional P7 design; it is discoverable
  and explained, not a defect. **Manual Google configuration** is documented
  (`docs/google-login-setup.md`, `docs/google-analytics-setup.md`,
  `docs/google-ads-setup.md`, `docs/oauth-scope-justification.md`).
- **No in-product monitoring** exists for background failures beyond the jobs
  list; that list is currently the monitoring, which makes the `[object Object]`
  bug more significant. Class **F**.

---

## 15. Known technical debt

| Item | Evidence | Assessment |
| --- | --- | --- |
| Legacy project-GSC path | `contentIntelligenceService.ts:251-256` queries a dropped column (`...000012...:104-106`) | **Should fix before feature X** — it is an active defect (Sec. 9) |
| Worker/job registry split | `apps/api/src/jobs/executors.ts`, `enqueue.ts`, `worker.ts` | Does not block launch |
| Ineffective job cancellation | job store `cancel` paths | Does not block launch |
| Orphaned `Data.tsx` | no importers in `apps/web/src` | Safe to defer / remove |
| Large components | `Keywords.tsx` 2202, `WriterPanel.tsx` 1528, `App.tsx` 1015, `Designer.tsx` 724, `EditorView.tsx` 711, `Publishing.tsx` 599 | Safe to defer |
| Publishing has no content identity | `Publishing.tsx:509-518` | Should fix before the measurement story is marketed (Sec. 8) |

No refactor is justified for its own sake. The only debt item that affects the
product now is the legacy GSC query.

---

## 16. Feature gaps

Only genuine missing capabilities are listed; each is judged by "does the
current product fail without it?"

- **Competitor keyword input** — product does not fail without it. The
  domain-based competitor flow already yields gaps and opportunities.
  Classification: **optional (D)**.
- **Google search inspiration** — product does not fail without it. DataForSEO
  research and expansion already provide inspiration. Classification:
  **optional future (D)**.
- **Automatic measurement sync** — product does not fail without it; explicit
  sync is intentional and discoverable (Sec. 9). Classification: **not
  required**.
- **Additional publishing providers** — product does not fail without them; the
  provider interface makes them additive. Classification: **future (D)**.
- **Password reset** — this is a genuine gap: a user who forgets their password
  has no recovery path (no `resetPasswordForEmail`/forgot flow exists).
  Classification: **B**.

---

## 17. Cheap-now / expensive-later

Work where postponement creates meaningful rework:

- **Publication <-> content identity.** Adding `content_id` to the composer and
  linking a publication to `seo_content` is cheap now and gets more expensive
  once publications and performance data accumulate (Sec. 8). Do this before
  promoting the measurement loop.
- **Measurement state vocabulary.** Expanding
  `ContentPerformanceState` beyond `measured`/`no_traffic` is cheap while the
  contract and one service own it, and prevents a later migration of persisted
  labels (Sec. 9).
- **Navigation label hygiene.** Renaming the duplicate "Integrations" and
  removing the stale "Content" copy is trivial now and avoids user confusion
  (Sec. 12).
- **Signup OTP type.** Confirming the correct Supabase `verifyOtp` type is a
  five-minute check that prevents a broken first-run experience (Sec. 5).

Ordinary polish (confirmations, empty-state wording) is intentionally excluded
from this list.

---

## 18. Landing-page truth

For each arrow in the honest product story:

| Stage / arrow | Classification |
| --- | --- |
| Google Search Console -> SEO intelligence | REAL |
| Google Analytics -> SEO intelligence | REAL |
| Google Ads -> paid intelligence | REAL |
| Keyword/competitor intelligence -> AI Writer | REAL |
| AI Writer -> Workspace | REAL (explicit "Use article") |
| Workspace -> WordPress / X | REAL (live URL captured) |
| Google -> Performance measurement | PARTIAL (explicit sync; only two states) |
| Performance -> back to research | REAL (human-driven) |

Nothing in the story is NOT IMPLEMENTED. The only PARTIAL arrow is the Google
measurement return path, because sync is manual and the state vocabulary is
coarse. A landing page may safely depict the REAL arrows and should describe
measurement as explicit and honest rather than automatic.

Misleading element to avoid: implying that connecting Google once authorizes
everything, and implying that the standalone composer is part of the content
loop. Neither is true today (Sec. 5, 8).

---

## 19. Launch definition

**Credible first release** = the smallest product that lets a user (1) sign in,
(2) create a project, (3) connect useful Google data, (4) research
opportunities, (5) create content, (6) edit it, (7) publish, (8) measure, (9)
understand what happened, and (10) return to research/content.

The application meets this definition today. The end-to-end journey is present
(Section 3), the measurement loop closes (Section 9), and the empty states guide
a new user (Section 11).

The exact remaining risks to a first release are:

1. signup/OTP verification against the live Supabase project (Section 5);
2. the permanently dark GSC page-signal source (Section 9/15);
3. no password reset (Section 16).

None of these is a design flaw requiring new architecture; all are small,
targeted fixes.

---

## 20. Stop-building test

> If we stopped adding major features here, would we have a product worth
> putting in front of real users?

Answer: **yes, with specific polish.**

The "specific polish" is bounded and does not include new features:

1. verify and fix the signup OTP type;
2. fix the GSC page-signal query so content intelligence is not dark;
3. link composer publications to content (and set content status on publish);
4. render job errors as messages instead of `[object Object]`;
5. add password reset;
6. correct the Google hub copy and stop one failed read from hiding all
   products;
7. add confirmations to API key revoke / integration delete.

This is a polish-and-release list, not a backlog.

---

## 21. Deferred work

Explicitly out of scope for the next phase, supported by the current product
direction:

- Competitor keyword input (optional per Section 6).
- Google search inspiration (optional per Section 6).
- Automatic measurement scheduler (explicit sync is intentional).
- Advanced automation / autonomous agents (no current need).
- Additional social platforms (WordPress + X are sufficient).
- Billing, plans and quotas (future; usage is honest counts only).
- Elaborate/predictive analytics and worker/job-registry or large-component refactors.
- Landing page/marketing before the measurement wording is factually tightened.

---

## 22. Recommended next phase

**B. Product polish**, followed directly by **F. Release preparation**.

Rationale:

- The product is already credible (Section 19), so **A. Feature completion** is
  not justified, and **C. Competitor/search inspiration** is optional.
- **D. Landing/marketing** should wait until the two potential overclaims
  (single Google authorization; composer in the content loop) are fixed.
- **E. Operational work** is close, but the immediate tasks are product-facing
  correctness/trust fixes, which is polish.
- **G. Stop and validate with users** is right *after* the short polish list;
  shipping with a dark GSC source and `[object Object]` job errors would invite
  avoidable first-impression damage.

Concretely: land the Section 20 polish list, then run **F. Release
preparation** (verification of the signup/OTP path against production Supabase,
migration application, and a scripted first-run smoke), then move to **G** to
put the product in front of real users.

---

## 23. Final conclusion

### 1. What is now a real product?

A project-scoped SEO workspace with working auth, a unified Google hub, keyword
and competitor research, an AI writing/editing workspace, WordPress/X
publishing, and an honest measurement loop surfaced on a Performance screen.

### 2. What remains incomplete?

- Signup/OTP correctness is unverified (Section 5).
- The GSC page-signal source in content intelligence is dark (Section 9/15).
- Publications created from the composer are not linked to content (Section 8).
- Job failures render as `[object Object]` (Section 14).
- Password reset is absent (Section 16); measurement distinguishes only
  measured/no-traffic (Section 9); no project rename/delete and destructive
  actions are unconfirmed (Section 13).

### 3. What actually blocks a first release?

No application-logic blocker was confirmed. The only candidate launch blocker is
the signup OTP type, which depends on the live Supabase configuration and must
be verified before release. The dark GSC source is a real defect but degrades
one signal, not the core loop.

### 4. What is merely polish?

Google hub copy and partial-failure handling, navigation duplicate/stale labels,
destructive-action confirmations, empty-state wording, and the prominence of the
Writer's "Use article" action.

### 5. What features are genuinely worth adding?

Only small, cheap-now correctness items: publication-to-content identity, a
richer measurement state vocabulary, and password reset. Competitor keyword
input and Google search inspiration are optional conveniences, not requirements.

### 6. What should deliberately remain out of scope?

Competitor keyword input as a requirement, Google search inspiration as a
requirement, an automatic measurement scheduler, autonomous agents, more social
providers, billing, worker refactors, and landing-page work before the product's
measurement wording is tightened.

### 7. Should we continue building, or is it time to put the product in front of users?

Stop adding major features. Land the bounded polish/release-prep list from
Sections 20 and 22, verify the signup path against production, and then put the
product in front of real users. The loop is closed; the remaining work is
credibility, not capability.
