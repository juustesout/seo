# R5 post-5.5 architecture reconnaissance

Status: **recon complete**. Documentation only. No application code, contracts,
routes, migrations, or tests were changed by this milestone.

Scope: R5.5 (Designer integration) is delivered, so this document re-examines
the unified workspace architecture as it actually exists at `6c472b7`, records
the ownership/source-of-truth model, checks the R5.2 session guarantees still
hold, maps the mutation and run architectures, and classifies what remains
before R5.6 (Editor integration). It is an input to planning, not a plan or an
implementation.

Binding inputs:

- `docs/phase-5-roadmap.md` (R5 high-level roadmap and R5.6 scope)
- `docs/r5.1-workspace-architecture-recon.md` (original recon and decisions)
- `docs/r5.5.5-designer-retirement.md` (Designer ownership + DesignPackage)
- `CLAUDE.md` (architecture invariants)

Every claim cites a symbol or `file:line` in the current working tree.

---

## 1. Architecture map

The unified workspace is a single React surface with three modes over one
document session. The layering, from route to mode, is:

```
App.tsx
  parseRoute / canonicalWorkspaceRoute  (lib/projectRoute.ts)
  redirect effect                        (App.tsx:149-162)
  workspaceActive / workspaceMode        (App.tsx:287-289)
  |
  v
ProjectWorkspaceShell                   (workspace/ProjectWorkspaceShell.tsx:58)
  WorkspaceSessionProvider
  DocumentSessionProvider
  WorkspaceStateProvider  (documentKey = session.boundary)
  |
  WorkspaceBody                          (ProjectWorkspaceShell.tsx:96)
  |-- WorkspaceModeSwitcher              (WorkspaceModeSwitcher.tsx:35)
  |-- WorkspaceChrome (when ready+canEdit) (WorkspaceChrome.tsx:40)
  `-- exactly one active mode:
        EditorMode    (EditorMode.tsx:51)
        ComposerMode  (ComposerMode.tsx:72)
        DesignerMode  (DesignerMode.tsx:59)
```

Shared infrastructure and its owners:

| Layer | File | Owns |
| --- | --- | --- |
| Session authority | `workspace/workspaceSession.tsx:105` | identity, loader, lifecycle, autosave, live fields |
| Identity + barrier | `session/useDocumentSession.ts:138` | `identity`, `generation`, frozen `boundary` |
| Identity-keyed loader | `session/useDocumentLoad.ts:39` | payload stamped by requested id |
| Lifecycle projection | `session/useDocumentSession.ts:64` | pure `documentLifecycle(identity, load)` |
| Revision contract | `components/content/documentRevision.ts:27,62` | `documentRevisionOf` / `workspaceRevisionOf` |
| Autosave | `components/content/useAutosave.ts` | baseline, dirty, single in-flight save |
| Mutation entry | `editor/EditorContext.tsx:127,153,163` | `applyExternalDocument` / `applyImageInsertion` / `applyDocumentOperations` |
| Mutation bridge | `workspace/CompositionApplyBridge.tsx:150` | stages + dispatches one proposal to a mutation path |
| Run controller | `workspace/useDesignerRunController.ts:65` | one durable run lifecycle for both run surfaces |
| Run primitives | `workspace/designerRunClient.ts` | paths, bookmark, active-status helpers |

The route model is a hand-rolled history router (`lib/projectRoute.ts:17`), not
a router library. The canonical workspace URL is
`/p/:projectId/workspace[/:mode[/:contentId]]`, where `sub` is the mode and
`sub2` the document id (`projectRoute.ts:10-14`, `App.tsx:287-289`).

Retired project views are resolved by `canonicalWorkspaceRoute`
(`projectRoute.ts:48`): `content` -> `workspace/editor[/:sub]`, `compose` ->
`workspace/composer`, `designer` -> `workspace/designer`. `App.tsx:149-162`
applies this with `window.history.replaceState`, so old links render the
canonical route once instead of a second implementation.

---

## 2. Ownership and source-of-truth table

One concern, one owner. `ProjectWorkspaceShell` and `workspaceSession` are the
only places that can create document state.

| Concern | Owner | Not owned by |
| --- | --- | --- |
| Project id, role | `useWorkspaceSession` args (`workspaceSession.tsx:105`) | modes (read via context) |
| Active document identity | `useDocumentSession.identity` (`useDocumentSession.ts:139`) | loaders, editors, modes, URL alone |
| Document epoch / boundary | frozen `session.boundary` (`useDocumentSession.ts:141,162`) | each consumer inventing a key |
| Document payload | `useDocumentLoad` (`workspaceSession.tsx:139`) | modes refetching `/content/:id` |
| Lifecycle (idle/loading/ready/error) | `documentLifecycle` (`useDocumentSession.ts:64`) | local readiness booleans |
| Live editable fields | `workspaceSession` state + `live` ref (`workspaceSession.tsx:129-148`) | a mode-local copy |
| Autosave / dirty / save status | single `useAutosave` (`workspaceSession.tsx:190`) | modes |
| Document revision | `documentRevisionOf(doc)` (`documentRevision.ts:27`) | a second hash |
| Workspace revision | `workspaceRevisionOf(state)` (`documentRevision.ts:62`) | autosave's own equality |
| Selection (coarse + normalized) | `EditorSelectionContext` / `EditorContext` (`EditorMode.tsx:128-136`) | Composer/Designer |
| Editor infrastructure | `EditorMode` (`EditorMode.tsx`) | Composer/Designer (isolation) |
| Document-scoped UI state | `useDocumentScopedState` keyed by `session.boundary` (`ProjectWorkspaceShell.tsx:113-114`) | global state |
| Mutation staging | `WorkspaceBody.pendingComposition` (`ProjectWorkspaceShell.tsx:119`) | modes writing directly |
| Durable run lifecycle | `useDesignerRunController` (`useDesignerRunController.ts:65`) | two run clients |
| Run presentation/policy | `useDesignerRun` / `useEmbeddedAgent` adapters | the controller |
| Composer ephemeral workflow | `views/Compose` (via `ComposerMode`) | the session |
| Designer API compatibility | `/designer/execute|intent|apply`, MCP `designer_*` | the web UI |

Key seam: `useWorkspaceSession` relocates the R5.2 owners but creates no new
identity, revision or autosave (`workspaceSession.tsx:10-14`). The session
`boundary` is the single epoch, shared by editor history, document-scoped UI
state, the mutation bridge and `useOperationBoundary`
(`useDocumentSession.ts:105-122`, `operationBoundary.ts:25`).

---

## 3. Composer / Designer / Editor comparison

| Dimension | Editor | Composer | Designer |
| --- | --- | --- | --- |
| Boundary file | `workspace/EditorMode.tsx:51` | `workspace/ComposerMode.tsx:72` | `workspace/DesignerMode.tsx:59` |
| Mounts Tiptap | yes (owns it) | no | no |
| Editor providers | `EditorSelectionProvider` + `EditorContextProvider` (`EditorMode.tsx:128-136`) | none | none |
| Editor keymap / AI state | yes (`EditorMode.tsx:96-125`) | no | no |
| Reads shared doc | `ws.doc`, `ws.live` | project/role/session only | `ws.doc`, `ws.title` |
| Writes the document | through editor transactions -> autosave | no (stages through shell) | no (stages through shell) |
| Own ephemeral state | preview/rail (shell), assistant open (doc-scoped) | brief, format, phase, plan, review | run phase, review, instruction |
| Handoff to editor | n/a (is the editor) | `onOpenEditor`, `onApplyToDocument`, `onAppendToDocument` (`ComposerMode.tsx:41-69`) | `onApplyProposal` (`DesignerMode.tsx:50`) |
| Review/nav hold | n/a | `onReviewOpenChange` (`ComposerMode.tsx:69`) | `onReviewOpenChange` (`DesignerMode.tsx:56`) |
| Run usage | embedded agent via `useEmbeddedAgent` | none | `useDesignerRun` |
| Document identity | shared session | shared session (handoff only) | shared session |

The isolation guarantee (R5.3.3) holds: Composer and Designer render no
`EditorContextProvider`, `EditorSelectionProvider` or Tiptap instance
(`ComposerMode.tsx:23-26`, `DesignerMode.tsx:31-33`). Both modes get the live
document as a derived canonical projection, never as a second fetch:
`DesignerMode.tsx:65-71` uses `canonicalFromEditorDocument(doc)`, and
`ProjectWorkspaceShell.tsx:123-129` computes the same projection for apply
eligibility.

Both modes hand a reviewed artifact back to the shell, which stages it and
switches to the editor mode; neither mode writes. This mirrors the Composer
and Designer paths exactly and is the single mutation funnel (section 5).

---

## 4. R5.2 regression check

R5.2 established the session guarantees. They are still enforced by tests and by
construction:

| Guarantee | Mechanism | Regression tests |
| --- | --- | --- |
| Save barrier before switching | `runBarrier` flushes before advancing identity; blocked on failure/in-progress (`useDocumentSession.ts:151-171`) | `useDocumentSession.test.ts` |
| Identity-keyed loader drops late responses | `useDocumentLoad` stamps state with the requested id (`useDocumentLoad.ts:39-93`) | `useDocumentLoad.test.tsx`, `documentLifecycle.test.tsx` |
| One lifecycle projection | pure `documentLifecycle` (`useDocumentSession.ts:64`) | `documentLifecycle.test.tsx` |
| Undo/redo scoped to the document | `editorHistoryKey` == frozen boundary (`useDocumentSession.ts:120`) | `undoRedoBoundary.test.tsx` |
| Async ops invalidated on switch | `useOperationBoundary` compares against frozen boundary (`operationBoundary.ts:25`) | `operationBoundary.test.tsx` |
| First-save id adoption preserves boundary | `adoptDocumentId` only changes identity (`useDocumentSession.ts:192`) | `adoptionBoundary.test.tsx` |
| Document-scoped UI state resets | `WorkspaceStateProvider documentKey=boundary` | `workspaceState.test.tsx` |
| One revision contract | `documentRevisionOf` == server `contentRevisionOf` | `documentRevision.test.ts` |

R5.4/R5.5 reused these seams rather than extending them. `ComposerMode`
composes the operation boundary with an unmount guard
(`ComposerMode.tsx:86-97`); `CompositionApplyBridge` compares both
`session.boundary` and `targetDocumentId` before writing
(`CompositionApplyBridge.tsx:162-174`). No new epoch, identity or autosave was
introduced. The R5.2 guarantees therefore still hold at `6c472b7`.

---

## 5. Mutation architecture

There is exactly one client-side mutation pipeline and it always runs through
the mounted editor.

```
staging (shell)                         apply (inside EditorContextProvider)
------------------------------------    -------------------------------------
pendingCompositionOf()          --\     CompositionApplyBridge
pendingAppendCompositionOf()    --->    |  boundary guard
pendingAppendCompositionFromBatch()     |  targetDocumentId guard
pendingDesignerMutation()       --/     |
                                        +-- mode 'replace'    -> applyExternalDocument
                                        +-- mode 'operations' -> applyDocumentOperations
                                        +-- mode 'insertion'  -> applyImageInsertion
```

Entry points on `EditorContext` (`EditorContext.tsx`):

| Entry | Guard sequence | Reuse |
| --- | --- | --- |
| `applyExternalDocument` (`:127`) | ready -> editor -> revision -> representable -> `setContent` | normal undoable transaction -> autosave |
| `applyImageInsertion` (`:153`) | ready -> editor -> revision -> operation | one undoable transaction |
| `applyDocumentOperations` (`:163`) | ready -> editor -> revision + batch revision -> representable -> operations -> `setContent` | one undoable transaction |

Designer proposals are classified before staging by `planDesignerMutation`
(`workspace/designerMutation.ts:54`): `operations` and `insertion` are
representable; `acquisition` (generation required) and document-only proposals
are explicitly refused with copy (`designerMutation.ts:42-47`). The shell then
re-guards identity and revision before staging
(`ProjectWorkspaceShell.tsx:314-342`). The legacy whole-document server apply
`POST /content/:id/designer/apply` is not on this path; it is retained only for
MCP `designer_apply` (section 8).

Operation vocabulary is bounded by contracts: `insert_section`, `insert_text`,
`insert_image`, max 32 operations, 500 chars of inserted text, backward
references only (`documentOperations.ts`). Every apply path ends in a single
`editor.commands.setContent(...)`, so the change takes one undo step and one
autosave, exactly like a normal edit.

---

## 6. Run architecture

One endpoint (`/projects/:projectId/designer/runs` + `/runs/:runId`), one
server engine, one client lifecycle, two surfaces.

```
Designer mode         useDesignerRun         --\
  (views/Designer)      adapter (components/designer/useDesignerRun.ts)
                                                   > useDesignerRunController
Editor embedded Agent  useEmbeddedAgent      --/    (workspace/useDesignerRunController.ts)
  (EditorMode)          adapter (workspace/useEmbeddedAgent.ts)
```

`useDesignerRunController` owns: restore-from-bookmark, submit, one epoch
identity guard, a poll loop that stops at a terminal status, bookmark
read/write/clear, and not-found/auth stop rules
(`useDesignerRunController.ts:1-13`). It owns no presentation; policy arrives
through `onRun` / `onError` / `onGone` / `onExhausted` / `onReset`
(`useDesignerRunController.ts:39-53`).

Surface policy split (behaviour-preserving, R5.5.4a):

| Aspect | Designer (`useDesignerRun`) | Embedded Agent (`useEmbeddedAgent`) |
| --- | --- | --- |
| Bookmark | project-scoped (`designerRunBookmarkKey`) | none (`bookmarkKey: null`) |
| Identity | `projectId` | `${projectId}:${contentId ?? 'new'}` |
| Poll budget | unbounded | `EMBEDDED_AGENT_MAX_POLLS = 60` |
| Outcome copy | Designer-specific | `embeddedAgentStateFromOutcome` |

Server side, `submitDesignRun` creates a `kind:'design'` run in `queued` status,
optionally reusing a run by idempotency key (`agentRunService.ts::submitDesignRun`);
the worker executes job `${AGENT_DESIGN_JOB_TYPE}:${runId}`. The client sends no
`idempotency_key` today (deferred, R5.5.4b).

Note: the controller reuses the same endpoints but keeps two distinct UI
policies, which is the approved R5.5.4a shape (shared server lifecycle, per-
surface presentation), not a hook-calls-hook refactor.

---

## 7. Routing and mode state

| Concern | Owner | Evidence |
| --- | --- | --- |
| Parse URL | `parseRoute` | `projectRoute.ts:17` |
| Serialize URL | `routePath` | `projectRoute.ts:34` |
| Legacy -> canonical | `canonicalWorkspaceRoute` | `projectRoute.ts:48` |
| Apply redirect | `replaceState` effect | `App.tsx:149-162` |
| Active mode | `normalizeWorkspaceMode(route.sub)` | `App.tsx:288`, `WorkspaceModeSwitcher.tsx:26` |
| Deep-linked document | `route.sub2` -> `initialContentId` | `App.tsx:289,327` |
| Mode change | `goProject(pid, 'workspace', mode)` | `App.tsx:328` |
| In-mode switch guard | `requestMode` review hold | `ProjectWorkspaceShell.tsx:167-182` |
| Switch history | push via `openProjectView` / `routePath` | `App.tsx:149-162` |

Mode is URL-backed but the document session is not remounted on a mode switch:
`ProjectWorkspaceShell` stays mounted and only the mode branch changes
(`ProjectWorkspaceShell.tsx:382-409`). The switcher defaults unknown modes to
`editor` (`WorkspaceModeSwitcher.tsx:26`). Composer and Designer can hold
navigation when a review is open, and that hold carries no review data
(`ProjectWorkspaceShell.tsx:155-182`).

Known limitation (not fixed by this recon): the redirect effect only reacts to
the parsed route on render; it does not handle `popstate` bookmarks specially.
Full back/forward behaviour is deferred.

---

## 8. DesignPackage boundary

`DesignPackage` lives in `packages/contracts/src/designPackage.ts` (types,
`exportDesignPackage` / `importDesignPackage` / `toPortableDesignPackage` /
`designPackageFromProposal` / `DesignPackageError`) and is re-exported from the
contracts index. It has **zero runtime consumers** in `apps/`, `supabase/`,
`scripts/` or MCP (confirmed by r5.5.5 section 5).

R5.5.5 decision, unchanged by this recon: retain `DesignPackage` as a portable,
versioned design artifact, explicitly not runtime document or session state. The
three representations remain separate:

```
CanonicalDocument = live workspace truth
DesignerProposal  = temporary, revision-bound proposed change (one run)
DesignPackage     = portable/shareable design artifact (export/import)
```

No workspace/session/document model may depend on `DesignPackage`. No
persistence, route, UI or conversion pipeline is added here.

---

## 9. Remaining gaps

Classification per the R5-post-5.5 scope: (A) required for R5.6, (B) R5.6
opportunities, (C) deferred / later. This is classification, not prioritisation.

### A. Required for R5.6 (Editor integration)

| # | Gap | Evidence | Why R5.6 needs it |
| --- | --- | --- | --- |
| A1 | Editor is the default mode already, but the deep-link path only opens a document given `sub2`; there is no "reopen last document" behaviour | `App.tsx:287-289`, `projectRoute.ts:17` | R5.6 makes editing the default stable entry; needs a deterministic open target |
| A2 | Editor chrome is still the full R1 toolbar/rail; R5.6 asks to simplify toolbars and make the canvas dominant | `EditorMode.tsx:155-167`, `views/EditorView` | Toolbar simplification is R5.6 work |
| A3 | SEO context integration (panel/rail) exists but is not contextualised to the canvas | `EditorMode.tsx`, `workspace/IntelligenceRail.tsx` | R5.6 explicitly integrates SEO context without overwhelming the canvas |
| A4 | Composer/Designer changes appear in the editor only after the mode switch + apply bridge; the editor state is updated through `setContent`, not inline | `CompositionApplyBridge.tsx:176-184` | R5.6 must ensure Composer/Designer changes appear immediately, which the bridge already does, but it is untested for the "editor already active" case |
| A5 | The editor's document-scoped UI state (`preview`, `rail`, assistant) is not persisted across a mode round-trip | `ProjectWorkspaceShell.tsx:113-114` | Stable editor return experience is part of "most stable interaction layer" |

### B. R5.6 opportunities (not strictly required)

| # | Opportunity | Evidence |
| --- | --- | --- |
| B1 | Rename `EditorWorkspace` / `EditorView` to a single clear editor-mode boundary | `r5.1` section 4.3; `workspace/EditorWorkspace.tsx` still exists |
| B2 | Consolidate the two preview entry points (`PreviewPane` and the editor canvas) | `PreviewPane.test.tsx`, `EditorMode.tsx:160` |
| B3 | Move `views/Compose` ephemeral workflow into a smaller composer surface | `ComposerMode.tsx:15-16` |
| B4 | Unify the two run-surface outcome copies | `useDesignerRun.ts`, `embeddedAgent.ts` |

### C. Deferred / later (out of R5.6)

| # | Item | Note |
| --- | --- | --- |
| C1 | R5.5.4b: idempotency key and bookmark/reconnect policy | explicitly deferred after R5.5.4a |
| C2 | `popstate` back/forward special handling | known routing limitation (section 7) |
| C3 | `DesignPackage` runtime integration | no consumer; retained as contract only |
| C4 | Migration `20260101000030_media_provenance.sql` runtime verification | not verified against local Postgres |
| C5 | R5.7 preview, R5.8 contextual UI, R5.9 admin, R5.10 metering, R5.11 hardening | later roadmap phases |

No gap above is a regression introduced by R5.5; they are either R5.6 scope or
explicitly deferred work.

---

## 10. R5.6 re-evaluation and decomposition

`docs/phase-5-roadmap.md:172-189` defines R5.6 as: embed the editor shell,
simplify toolbars, preserve text editing and block selection, integrate SEO
context without overwhelming the canvas, integrate the embedded agent, ensure
Composer/Designer changes appear immediately, and make the editor the default
mode for an existing document.

Re-evaluation against the current architecture:

- The editor is already embedded and is already the default mode
  (`WorkspaceModeSwitcher.tsx:26`, `ProjectWorkspaceShell.tsx:145`), so the
  "default mode" decision in the roadmap is effectively satisfied. R5.6 should
  confirm and test it, not rebuild it.
- The embedded agent is already integrated through the shared run controller and
  the editor's `EmbeddedAgentEntry` (`EditorMode.tsx:146-153`).
- Composer/Designer changes already appear in the editor through the single
  mutation bridge (`CompositionApplyBridge.tsx`). R5.6 should harden and test
  the "editor already active" branch rather than add a new path.
- The unbuilt parts are the simplification/contextualisation of editor chrome
  (A2, A3) and the default-open/last-document behaviour (A1).
- The biggest risk to R5.6 is creating a second document or editor path; the
  architecture explicitly forbids it (`workspaceSession.tsx:10-14`). Any R5.6
  slice must consume the shared session, as R5.4/R5.5 did.

Proposed decomposition, smallest verifiable slices (each typecheck/build/test
green, no PR):

1. **R5.6.0 recon**: confirm the editor default-open behaviour and inventory
   toolbar/rail/SEO surfaces with exact file:line, classify keep/simplify/retire.
2. **R5.6.1 default-open**: deterministic document open for
   `/p/:id/workspace/editor` (including no-document and last-document cases).
3. **R5.6.2 toolbar simplification**: reduce editor chrome to a canvas-dominant
   set; no change to the shared session or mutation paths.
4. **R5.6.3 contextual SEO**: make the SEO surface appear only when relevant to
   the canvas/selection; reuse `EditorContext`/selection, add no state owner.
5. **R5.6.4 immediate-change hardening**: tests and any fix for
   Composer/Designer -> editor apply while the editor is already mounted.
6. **R5.6.5 editor integration recon/close-out**: record the final editor
   ownership and what moved to R5.7/R5.8.

This decomposition is a recommendation for the next planning call; it is not
approved or started by this document.

---

## 11. R5 completion matrix

| Milestone | Deliverable | Status | Evidence |
| --- | --- | --- | --- |
| R5.1 | Architecture + route recon | delivered | `docs/r5.1-workspace-architecture-recon.md` |
| R5.2 | Unified document/session state | delivered | `docs/r5.2.1`..`r5.2.9`; session tests |
| R5.3 | Three-mode workspace shell | delivered | `docs/r5.3.1`..`r5.3.3`; `ProjectWorkspaceShell.test.tsx`, `.isolation.test.tsx` |
| R5.4 | Composer integration | delivered | `docs/r5.4.1`..`r5.4.7`; composer shell tests |
| R5.5 | Designer integration | delivered | `docs/r5.5.0`..`r5.5.5`; `DesignerMode.test.tsx`, `.designerApply.test.tsx`, `useDesignerRunController.test.tsx` |
| R5.6 | Editor integration | not started | this document, section 10 |
| R5.7 | Preview / responsive | not started | `docs/phase-5-roadmap.md:191` |
| R5.8 | Simplified contextual UI | not started | `docs/phase-5-roadmap.md:208` |
| R5.9 | Account/project admin | not started | `docs/phase-5-roadmap.md:240` |
| R5.10 | Usage metering | not started | `docs/phase-5-roadmap.md:274` |
| R5.11 | End-to-end hardening | not started | `docs/phase-5-roadmap.md:338` |

Current verification baseline at `6c472b7` (last recorded run): `@seo/contracts`
build clean, `@seo/api` typecheck/build clean, `@seo/web` typecheck/build clean,
tests contracts 483 / web 643 / API 1658. This recon changed only this document,
so the baseline is unchanged.

Open known items carried forward: migration
`supabase/migrations/20260101000030_media_provenance.sql` is not runtime-verified
against a fresh local Postgres (`scripts/db-migrate-local.sh`); `popstate`
back/forward handling is deferred; R5.5.4b is deferred.
