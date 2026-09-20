# Editor-Native Designer — Product & UX Contract (ADR Phase R0)

Status: **R0 done (recon + contract); R1 done (editor shell built)**. This document is the product handle for
the R-series. `docs/editor-native-designer-roadmap.md` is the guiding brief and
stays authoritative for intent; this document turns that intent into concrete
product rules and records what the current UI actually is.

Recon evidence was taken at `HEAD 2907297` (`feat(designer): expose the Designer
lifecycle over MCP (ADR Phase 5.4)`). No production code was changed by R0.

Scope of R0: describe how the product must behave for the user. It adds no
feature, route, endpoint or capability.

---

## 1. Product premise

The one sentence the whole rebuild serves:

> The user works in the Editor. AI capability comes to the user, not the other
> way around.

Consequences that are binding from R1 onward:

- The Editor is the product, not one module next to Designer.
- Designer is one intelligent capability inside the Editor.
- Backend infrastructure (durable runs, proposals, revisions, conflict checks,
  capabilities, MCP, audit) may remain exactly as it is; the user must never be
  required to understand it.

---

## 2. Verified inventory of today's UI

This is what exists now, verified in code, before any R-series change.

### 2.1 Account areas

`apps/web/src/App.tsx` defines the top navigation in `TOP_NAV` (L102-108) and a
hand-rolled history router (`parseRoute` L87-94, `routePath` L97-100).

| Route | View | Role today |
| --- | --- | --- |
| `/overview` | `views/Overview.tsx` | Account performance/welcome |
| `/projects` | `views/ProjectsPage.tsx` | Project list + create |
| `/compose` | `views/Compose.tsx` | Top-level creation shortcut; silently uses the user's first project (L339, L355-362) |
| `/integrations` | `views/AccountIntegrations.tsx` | Account-level integrations |
| `/keys` | `views/AccountApiKeys.tsx` | Account API keys |

### 2.2 Project workspace

`PROJECT_NAV` (`apps/web/src/App.tsx` L110-122) renders the project sidebar
(`ProjectSidebar` L464-499) and switches views at `/p/:projectId/:view`
(L311-331).

| View id | Label | Component | Role today |
| --- | --- | --- | --- |
| `dashboard` | Dashboard | `views/Dashboard.tsx` | Project home |
| `keywords` | Keywords | `views/Keywords.tsx` | Research/rankings workspace |
| `integrations` | Integrations | `views/Integrations.tsx` | Project integrations |
| `knowledge` | Knowledge Base | `views/Knowledge.tsx` | Knowledge workspace (URL sub-sections) |
| `content` | Content Studio | `views/Content.tsx` | **The Editor** (list, viewer, editor) |
| `designer` | Designer | `views/Designer.tsx` | Standalone Designer page |
| `compose` | Compose | `views/Compose.tsx` | Creation workflow |
| `calendar` | Calendar | `views/ContentSchedule.tsx` | Scheduling |
| `publications` | Publications | `views/Publications.tsx` | Publication history |
| `publishing` | Publishing | `views/Publishing.tsx` | Connect output channels |
| `settings` | Settings | `views/ProjectSettings.tsx` | GSC property + project config |

### 2.3 The Editor today (`views/Content.tsx`)

`Content` (L94-816) has three branches selected by role and selection state:

- **List** (L482-577): article table, "Start article" form, Schedule calendar
  button.
- **Read-only viewer** (L589-632): a server-rendered `content_html` render for
  viewers (`dangerouslySetInnerHTML` L623). Deliberately not a disabled editor.
- **Editor** (L644-815): `ContentEditorHeader` (title/status/autosave/delete/
  publications), `EditorShell` + `ContentToolbar` + `RichTextEditor`, and a
  right column of stacked panels: `AgentControls`, `SeoPanel`, `ContentOutline`,
  `MediaPanel`, `IntelligencePanel`, with `WriterPanel`, `ContentAiPanel`,
  `ContentAiEditPanel` and `KnowledgePanel` below/around it.

Finding: the Editor is already feature-rich, but it reads as a *collection of
development panels*. This is exactly the "losse kamers" the roadmap names.

### 2.4 The standalone Designer today (`views/Designer.tsx`)

- Role gate `ROLE_RANK` L36, `canEdit` L92.
- Two modes share one page: `DesignerMode = 'create' | 'edit'` (L47), with a
  document list used as a **selector** in edit mode (L109-115) and a
  side-by-side saved-vs-proposal review (`EditReview` L408-568).
- Technical state labels are the primary status UI: `PHASE_LABEL`
  (L38-45) renders `Idle / Submitting / Queued / Running / Succeeded / Failed`.
- Visual provenance is shown read-only (`VisualProvenance` L574+).

Finding: this page directly contradicts roadmap principles 1.2 (AI as
destination), 1.4 (internal state as UI) and 1.5 (product language). It must
degrade into an embedded capability, not be polished in place.

### 2.5 Media today (`components/content/MediaPanel.tsx`)

- Project-scoped library list (`api('/projects/:id/media')` L60), upload with a
  client courtesy cap of 8 MB (L18, L77-80; the server enforces the real cap).
- Insert at the caret as a stable `mediaId` node (L98-108) — with `window.prompt`
  for alt text.
- Admin-gated delete; the API refuses to delete a referenced asset (L127-139).

Finding: a solid, honest base for image work. It is manual and panel-bound, not
intent-driven and not location-aware.

### 2.6 Composer today (`views/Compose.tsx`)

A creation workflow, reachable both top-level and inside a project. It deep-links
into the Editor on success (`onOpenEditor` → `goProject(pid, 'content', contentId)`,
App.tsx L327). It is not, and must not become, the path for ordinary edits.

### 2.7 Backend capability that already exists

Relevant to the first slice and already real and tested:

- Durable Designer runs: `POST/GET /api/projects/:projectId/designer/runs`
  (`apps/api/src/http/routes/designer.ts` L12-15, mounted `app.ts` L144-145).
- Synchronous server-only paths `POST /designer/execute` and
  `POST /designer/intent` (designer.ts L5-8). Verified: the web client never
  calls these; it only uses `/designer/runs` and `/designer/apply`
  (`components/designer/useDesignerRun.ts` L67, L139; `views/Designer.tsx` L178).
- Deterministic visual asset selection over existing project media metadata
  (`packages/contracts/src/visualAssetSelection.ts`).
- Revision-guarded apply, refusing stale proposals with `409 stale_proposal`
  (`POST /content/:contentId/designer/apply`).

### 2.8 What the inventory already satisfies

- Structured document as source of truth; HTML only as a render (Content.tsx
  header).
- Review-before-apply for AI edits; no auto-apply (`ContentAiPanel`,
  `ContentAiEditPanel`, `WriterPanel`).
- Honest state for jobs and providers (no fabricated metrics).
- Capability-driven providers and role gating.

---

## 3. Contract: role of every surface

Verdicts are binding for R1-R8; R9 is allowed to remove, not add.

| Surface | Verdict | Phase | Contract |
| --- | --- | --- | --- |
| Editor (`content`) | **Primary workspace** — expand | R1+ | The one place the user edits, asks, previews, applies, undoes and publishes. |
| Standalone Designer | **Degrade to embedded capability** — remove the nav entry and the page once the embedded flow exists | R2, R4, R9 | No design action may require leaving the Editor. |
| Composer | **Creation workflow only** | R2/R9 | Keep for new-document creation; never the route for ordinary edits. The top-level `/compose` duplicate is a removal candidate at R9. |
| Media | **Contextual part of the Editor** | R3/R9 | Intent-driven insertion; an optional library surface is secondary, not a destination. |
| SEO | **Intelligence panel inside Editor/project** | R7/R9 | Never a standalone destination. |
| Publish / schedule | **Editor action** (+ Calendar for planning) | R4/R9 | Publish from the document; Calendar stays for scheduling. |
| Publications | Secondary history | R9 | "What happened", not an edit surface. |
| Calendar | Secondary planning | R9 | Keep. |
| Keywords / Knowledge / Integrations / Settings / Dashboard | Project intelligence and configuration | R9 | Keep, outside the edit loop. |
| Agent runs (`useDesignerRun`, run rows) | **Internal infrastructure** | R4/R9 | Never primary navigation; users see results, not runs. |

Hard rule for R1-R8: **no new route unless technically unavoidable.** The R-series
does not add pages; it integrates capability into the Editor.

---

## 4. Interaction principles (made concrete)

1. **Stay.** Opening a document enters the workspace; no edit action navigates
   away.
2. **Contextual entry.** AI is reachable from the active block/cursor/selection
   through a toolbar, a shortcut, a context menu or an inline command — never
   through a page.
3. **Progressive disclosure.** Clear outcome first ("3 verbeterpunten"), depth on
   request ("Toon waarom").
4. **One action, one result.** Every action ends in one understandable product
   statement (see §5).
5. **Undo is always available.** AI changes are normal editor transactions, not a
   separate save mode.
6. **Keyboard-first, then pointer.** Core flows work without the mouse.
7. **Calm by default.** Empty, loading and error states are quiet, short and in
   product language.

---

## 5. Terminology contract

Internal terms must not reach the user. Left column is forbidden in UI copy;
right column is the product language.

| Internal (never shown) | Product language |
| --- | --- |
| `queued` / `running` / `succeeded` / `failed` | "Bezig…" / "Klaar" (or a specific result) |
| Proposal / `DesignerProposal` | "Voorstel" / "Wijziging" |
| base revision / revision hash / content id | *(never shown)* |
| "document found" | *(no message; the document is simply the context)* |
| capability / domain / planner / executor / MCP / run | *(never shown)* |
| `visual.apply` / `select_asset` | "Afbeelding zoeken" / "Afbeelding plaatsen" |
| Apply / Reject | "Toepassen" / "Niet gebruiken" |
| error codes (`503`, `409 stale_proposal`) | "Dit lukt nu niet. Probeer opnieuw." / "Je document is ondertussen gewijzigd." |

Required result language (examples, per roadmap 1.5): "Afbeelding toegevoegd",
"Tekst verbeterd", "SEO-titel voorgesteld", "3 varianten beschikbaar",
"Kan geen geschikte afbeelding vinden".

---

## 6. States and feedback contract

| State | Contract |
| --- | --- |
| Idle | No AI chrome dominating the canvas; entry points are discoverable but quiet. |
| Working | A single, local, non-blocking indicator near the action. Never a full-screen spinner over the document. |
| Result (applied) | The change is visible in place; a short confirmation and an Undo affordance. |
| Result (proposed) | The change is previewed in place; apply/don't-use affordances in the Editor. |
| Empty | Calm guidance, no technical explanation. |
| Error | Honest, specific, recoverable. Provider not configured is stated as "not configured", never simulated. |
| Uncertain | Say so ("Kan geen geschikte afbeelding vinden"); do not fabricate. |

Rule: the technical run lifecycle stays internal. The Editor may show that work
is in progress and what the outcome is; it must not present run states as the
product's main interface.

---

## 7. Inline AI rules

1. The active project and active document are implied; no selectors.
2. The active selection/block/cursor is implied context, not a user task.
3. Review-before-apply is required for changes with real risk; low-risk direct
   actions may apply immediately with Undo.
4. Nothing auto-publishes.
5. Every write passes through the existing revision-guarded apply choke point;
   conflict is surfaced as product language, never as a raw 409.
6. No credentials or provider keys are ever read, stored or displayed client
   side (BYOK stays server-side).
7. A capability that is not configured is reported as not configured.

---

## 8. Context rules

Context the Editor must supply (automatically, server-bound where applicable):

- active project and active document;
- the document's current server-derived revision;
- current selection, active block and cursor position;
- nearby text and document structure (for placement and tone);
- available project media (metadata only);
- the user's instruction.

Forbidden context surfaces: a document selector, a project selector when a
project is already active, and any visible content id or revision token.

**Current code gap (R0 finding).** `DesignerIntentContext` already carries an
opaque `selection` and shallow `metadata`
(`packages/contracts/src/designer.ts` L585-610), but visual targeting does not
use a location: `collectVisualTargets`
(`packages/contracts/src/visualAssetSelection.ts` L264-320) only collects
already-existing `image` blocks. R2/R3 must define a minimal, validated
context-to-target contract instead of smuggling placement through opaque data.

---

## 9. Preview, apply and undo

- The user sees the change in the existing Editor, at the intended location.
- Risky changes are previewed with a subtle marker of what changed, plus Apply,
  Undo, optionally "Andere optie" and "Niet gebruiken".
- The backend may keep working with base revisions, proposals, stale checks,
  durable runs and audit. The user does not see that model.
- Out of bounds for this flow: a separate proposal/review page, a detached
  preview outside the Editor, a modal with a second editor, or an "open result"
  button.

---

## 10. Errors and uncertainty

- Failures surface on the action, in product language, with a recovery path.
- "No suitable result" is a normal, expected outcome, not an error code.
- Not-configured capabilities are stated honestly; nothing is faked.
- Partial results are reported as partial; no silent zeroing.

---

## 11. Gap analysis for the first vertical slice (R3, image insertion)

Definition of done (roadmap §7): in the Editor, "Zet daar een passende
afbeelding" resolves the location from active context, finds an image (or fails
honestly), shows it in place, and lets the user accept/change/undo without
leaving the workspace and without visible technical steps.

Already in place:

- Project media library with metadata and a stable `mediaId` document node.
- Deterministic asset selection over existing media metadata.
- A planner that offers `visual.apply` with an open `select` task (no ids named).
- Durable run + revision-guarded apply + honest typed errors.
- In-editor image insertion mechanics (Tiptap `insertMedia`).

Missing, and therefore the real R3 work:

1. **Insertion at a location.** Current selection only *fills existing image
   blocks*; a text document has no target, so "insert a new image here" is not
   yet expressible. R3 needs the smallest honest way to create an image block at
   a resolved position (a location-aware insertion operation, or a layout step
   that places a block before/after a target), without inventing an asset.
2. **Location context reaching the backend.** Cursor/selection/block context must
   be carried in a validated, bounded shape and must actually drive targeting.
3. **In-Editor review/apply/undo.** The existing review UI lives in the
   standalone Designer and must move into the Editor (R4).
4. **Honest capability state.** When no AI provider is configured, the Editor
   must say so; when no asset matches, it must say that, not crash.
5. **Discoverability without a dashboard.** The flow must be discoverable through
   Editor affordances, not through a runs list.

R0 does not decide the mechanism for (1); that is an R2/R3 design decision. R0
only fixes the requirement and the constraints (no fabricated asset, no new
route, no leaked internals).

---

## 12. R0 decisions (binding)

1. The Editor is the product; Designer is a capability inside it.
2. No standalone Designer page for edit actions; the current page degrades and is
   removed at R9, not before.
3. No project/document selectors in the editor agent.
4. No technical run status as primary UI; product language only.
5. No new route for R1-R8 unless technically unavoidable.
6. No new UI surface without concrete user value.
7. No backend capability without a matching user flow.
8. Preview, apply and undo happen inside the Editor; no separate review page.
9. All writes keep the existing revision-guarded apply choke point.
10. Internal infrastructure stays available and hidden: durable runs, proposals,
    revisions, conflicts, capabilities, MCP, audit.
11. AI is review-before-apply for risky changes; nothing auto-publishes.
12. Honesty over polish: not configured, no match and partial results are stated
    plainly.

---

## 13. Non-goals (unchanged from the roadmap)

Collaborative editing; a generic agent marketplace; complex multi-agent chat; a
full free canvas editor; an arbitrary CSS design system; auto-publish without
user control; a new backend run framework; a separate page per AI capability; a
generic chat UI before the concrete interactions work; an "AI dashboard" that
overshadows the Editor.

---

## 14. Phase status

| Phase | Name | Status |
| --- | --- | --- |
| R0 | Product Reset & Experience Contract | **Done** (this document) |
| R1 | Editor Shell & Interaction Foundation | **Done** (R1.1 recon + shell build) |
| R2 | Embedded Designer Agent Shell | Not started |
| R3 | First Vertical Slice, Image Insertion | Not started |
| R4 | In-Editor Proposal, Apply & Undo | Not started |
| R5 | Contextual Designer Actions | Not started |
| R6 | Designer Capabilities as Native Editor Tools | Not started |
| R7 | Unified Intelligence Layer | Not started |
| R8 | Professional Polish | Not started |
| R9 | Simplification Pass & Navigation Cleanup | Not started |

---

## 15. Handoff to the next briefing

Next deliverable: **Phase R2 — Embedded Designer Agent Shell**. The R1 shell is
in place (`EditorWorkspace`, one `DocumentHeader`, merged `ContextualToolbar`,
`IntelligenceRail`, lifted `EditorSelectionContext`, in-editor `PreviewPane`, a
reserved `InlineAssistantSlot`, a workspace keymap and an on-demand insert rail),
so the agent can land in that fixed place instead of becoming another panel. R2
must build on the R1.1 recon (`docs/editor-shell-recon.md`); it must not add a
route or bolt on a parallel surface.

After R2 comes the first real build slice: **Phase R3.1 — Embedded Designer Image
Insertion**, measured only by the §11 definition of done.

---

## See also

- `docs/editor-native-designer-roadmap.md` — the guiding brief (Dutch, verbatim).
- `docs/8e6-agent-architecture.md` — the Designer/Writer/Composer backend ADR
  whose infrastructure R0 keeps and hides.
- `docs/content-studio-roadmap.md`, `docs/w10-magic-roadmap.md` — prior
  Content Studio and writer roadmaps.
