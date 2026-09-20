# 8E.6 — Agent architecture: Designer, Writer & Composer

Status: agreed architecture decision record. Recon complete, decisions locked.
No implementation until a separate implementation brief is issued.

This document combines the 8E.6 recon with the decisions taken on top of it. It
is the reference for the later orchestration brief.

## 1. Context

The Content Studio already separates free-text editing from composition-based
pages. The 8E.6 goal is to add a Designer role above the existing specialists
without duplicating them.

The central finding of the recon: the repository already contains two things
called "writer". This collision is the problem to resolve first.

1. `apps/api/src/agents/writer/*` — the Writer Engine for free text and
   articles. This is the "Writer Agent".
2. `apps/api/src/agents/composition/writer.ts` plus
   `packages/contracts/src/compositionWriter.ts` — a slot-fill writer inside the
   composition chain. Semantically this is a writer capability, not the
   Composer.

The Composition Planner (`apps/api/src/agents/composition/planner.ts`) plus the
deterministic compiler (`packages/contracts/src/compositionPlan.ts`) together
form today's "Composer".

So 8E.6 is: add a Designer orchestration layer on top of what exists, and make
the writer/composer overlap explicit. It is not a greenfield rebuild.

## 2. Existing architecture

### 2.1 Generation chain 1: Writer Engine (free text, human-gated, durable)

```
REST POST /api/projects/:projectId/content/:contentId/writer
  -> WriterRunService
      -> durable LangGraph run + Postgres checkpoints
      -> createWriterGraph
           context -> planOutline -> [awaitApproval] -> writeSections -> review
                    -> [awaitReviewSession] -> reviseSections / magic
                    -> evidence / intelligence / agent
      -> persist via ContentService
```

- Input: `WriterInput` (`packages/contracts/src/writer.ts:133`) or the lighter
  `WriterRunRequest` (`apps/api/src/agents/writer/index.ts:178`).
- Output: TipDoc in `seo_content.content_json`, plus derived `content_html`,
  `outline`, `seo_score`.
- AI boundaries are separate, Zod-validated, bounded modules with
  `WriterAiResolver` (`apps/api/src/agents/writer/planner.ts:154`). There is no
  open tool loop.
- Dependencies are injectable via `WriterRunDependencies`
  (`apps/api/src/agents/writer/index.ts:197`); optional ones degrade honestly.
- The persistence seam `WriterPersistence` (`apps/api/src/agents/writer/engine.ts:201`)
  already exists.
- Two human interrupts: plan approval and review session.

### 2.2 Generation chain 2: Composition (layout, proposal-only)

```
REST POST /api/projects/:projectId/composition/plan
REST POST /api/projects/:projectId/composition/compose
  -> CompositionService.compose
       getCosmosContext
       -> [CompositionPlannerService.plan -> AI planner]
       -> compileComposition(plan)
       -> createAiCompositionWriter
       -> applyCompositionSlotFills
       => { compositionPlan, canonicalDocument }
```

- `CompositionService.compose` (`apps/api/src/services/compositionService.ts:76`),
  `ComposeResult` (`:45`).
- `compileComposition` (`packages/contracts/src/compositionPlan.ts:420`),
  `CompiledComposition` (`:357`), `CompositionSlotMap` (`:353`).
- `CompositionSlotFill` (`packages/contracts/src/compositionWriter.ts:39`),
  `validateCompositionSlotFills` (`:115`), `applyCompositionSlotFills` (`:242`).
- `createAiCompositionWriter` (`apps/api/src/agents/composition/writer.ts:167`).
- Nothing is persisted (`apps/api/src/services/compositionService.ts:15`).
- Web `Compose.tsx` previews with `CanonicalRenderer` and no design-system prop
  (`apps/web/src/views/Compose.tsx:249`), so it resolves to the default.
- "Open in Editor" (`Compose.tsx:138`) calls `editorDraftFromCanonical`
  (`apps/web/src/components/content/editorDraft.ts:40`), which calls
  `canonicalDocumentToEditorDocument`
  (`packages/contracts/src/editorHandoff.ts:182`), then POSTs a draft.

### 2.3 Canonical document model

- `CanonicalDocument { version: 1; blocks: CanonicalBlock[]; meta? }`
  (`packages/contracts/src/canonical.ts:283`).
- `CanonicalBlock { id?, type, attrs?, content?, children?, source?, rawHtml? }`
  (`canonical.ts:258`).
- Strict whitelists: `CANONICAL_COMPOSITION_ATTR_KEYS` (`canonical.ts:152`),
  `CANONICAL_BLOCK_VARIANTS` (`:107`), layout intent (`:139`), CSS firewall
  against `style/class/css` (`:198`), max 5000 blocks, max depth 200.
- Conversions that already exist:
  - `tiptapToCanonical` / `canonicalToTiptap`
    (`packages/contracts/src/tiptapAdapter.ts:227`, `:378`).
  - `canonicalDocumentToEditorDocument` (`editorHandoff.ts:182`) — in use.
  - `editorDocumentToCanonical` (`editorHandoff.ts:222`) — no production caller
    today; only tests.

### 2.4 Design system and Cosmos

- `CosmosConfig { ...; design?: CosmosDesign }`
  (`packages/contracts/src/cosmos.ts:135`); `CosmosDesign` carries bounded
  colors/typography/spacing/radius/elevation.
- Stored in `seo_projects.settings.cosmos`
  (`supabase/migrations/20260101000002_projects_members.sql:17`), served by
  `cosmosService.ts` and the `/cosmos` route.
- `resolveDesignSystem` (`packages/contracts/src/designSystem.ts:157`) and
  `designSystemCssVariables` (`:197`) exist but have no production callers.
  `CanonicalRenderer` always falls back to `DEFAULT_DESIGN_SYSTEM`
  (`apps/web/src/components/canonicalRenderer/CanonicalRenderer.tsx:53`).
- `CanonicalMeta.designSystem?: CanonicalDesignSystemRef`
  (`canonical.ts:174`) validates but is never set or read.
- The Cosmos panel has no design-token UI.

### 2.5 Persistence, jobs, HITL, auth

- Content: `seo_content.content_json` (TipDoc) is the source of truth.
  `ContentService.write` (`apps/api/src/services/contentService.ts:173`) is the
  only normalization/persistence choke point.
- Jobs: `JobStore` interface (`apps/api/src/jobs/types.ts:45`), executor
  registry (`apps/api/src/jobs/executors.ts:971`), worker with claim/retry and
  backoff. Deliberately thin and transport-swappable.
- HITL already exists in three forms: Writer plan approval, Content AI edit
  review-before-apply, and Knowledge discovery review-then-apply.
- RBAC: `container.access.requireRole(user.sub, projectId, role)` on every
  route; service-role plus RLS as defense in depth.

## 3. Target architecture

```
                    USER
                      |
                      v
               DESIGNER AGENT
              intent -> plan
                      |
          +-----------+-----------+
          v                       v
      WRITER AGENT          COMPOSER AGENT
      ------------          --------------
      copy                  structure
      slot fills            layout
      text                  variants
                            design ref
          |                       |
          +-----------+-----------+
                      v
               CANONICAL DOCUMENT
                      |
                 validation
                      |
                   proposal
                      |
                 USER APPROVAL
                      |
                      v
                   EDITOR
                      |
                      v
               seo_content / TipDoc
                      |
                      v
              CANONICAL RENDERER
```

Boundaries in one line: Composer decides where and how, Writer decides what it
says, Designer decides what to ask for and whether the result holds together,
the Editor is the only human mutator, the Renderer only renders.

## 4. Decisions

| ID | Topic | Decision |
|----|-------|----------|
| H1 | Writer output | CanonicalDocument at the agent boundary. Writer may use TipDoc internally as its existing motor, but returns Canonical. No `ContentService.write` during a Designer run. |
| H2 | Slot fill | Slot fill belongs to Writer. `compositionWriter` becomes a Writer capability. Composer declares slots; Writer fills them. |
| H3 | Designer run model | Start synchronous; keep the architecture job-ready. Own `seo_agent_runs` later; not now. |
| H4 | Designer intelligence | AI only for intent to DesignerPlan. Orchestration is deterministic. No recursive Designer calls, no agent-to-agent calls, bounded steps. |
| H5 | Design direction | Designer chooses existing Cosmos design-system options. No new color-picker UI. Wire the existing `resolveDesignSystem` in the same phase. |
| H6 | Concurrency | `baseRevision` guard (hash of `content_json`, or a reliable revision). Apply only when the current revision matches; otherwise `STALE_PROPOSAL`. |
| H7 | Approval | One complete design proposal per run, one approval. Not per step. |
| H8 | Design Package | Project-owned, portable `DesignPackage v1`, versioned, exportable cross-project. No project-scoped IDs. |
| H9 | Naming | Rename `agents/composition/writer.ts` to a Writer capability (for example `agents/writer/compositionSlotFiller.ts`). Conceptually one Writer capability. |
| H10 | MCP | Later. REST/service contracts first. MCP becomes a second mouth on the same DesignerService. No separate MCP agent logic. |

### H1 flow in detail

```
Writer (internal)
   v
TipDoc
   v
CanonicalDocument
   v
Designer

after human acceptance:

Final Canonical
   v
Editor
   v
ContentService.write
```

Agents stay proposal-based. They never mutate content outside the Editor.

### H4 budget (from day one)

- maximum number of Designer steps.
- at most one Writer free-text task and one Writer slot-fill task per slot
  group.
- at most one Composer structure task.
- no recursive Designer calls.
- no direct agent-to-agent communication.

## 5. Responsibility matrix

| Layer | May | May not | Module |
|-------|-----|---------|--------|
| Designer Agent | Interpret intent; choose format; split work into typed steps; choose design direction from existing Cosmos options; delegate to Writer and Composer; validate; request revision; propose `designSystemRef` | Write copy; compile structure; write `seo_content`; call providers directly; leave the bounded whitelists | New `DesignerService` plus contracts |
| Writer Agent | Produce free text; fill Composer-declared copy slots with `CompositionSlotFill[]` | Change structure, types, heading levels, order, nesting; set layout or variants; invent media, metrics or attribution; change design tokens | `agents/writer/*`, plus the reclassified slot filler |
| Composer Agent | Choose structure; produce `CompositionPlan`; compile to a skeleton `CanonicalDocument`; produce `CompositionSlotMap`; bounded variants and layout intent; design-system reference | Invent copy beyond minimal structural placeholders; fill media, metrics or attribution; raw CSS/HTML/classes; write `seo_content` | `agents/composition/planner.ts`, `compositionPlan.ts`, `compositionService.ts` |
| Editor | Human mutation of the TipDoc; insert/select/edit; accept or reject proposals; autosave; title/status/meta | Render canonical; contain agent logic; see credentials | `RichTextEditor.tsx`, `EditorShell.tsx`, `views/Content.tsx` |
| Canonical Renderer | Purely render `CanonicalDocument` plus resolved `DesignSystem`; `--cosmos-*` scope; never mutate | Mutate documents; call providers or AI; persist; make decisions | `CanonicalRenderer.tsx`, `blocks.tsx`, `canonicalRenderer.css` |

Hard data boundaries:

- Only the Editor/autosave writes `seo_content.content_json`, through
  `ContentService.write`.
- Only Composer owns `CompositionPlan`, `CompiledComposition` and the skeleton.
- Only Writer owns free copy and slot-fill text.
- Only Designer owns the `DesignerPlan` and `DesignerReview`.
- No one except the Editor mutates an existing document in place.

## 6. Agent contracts

Recommendation: typed, validated JSON contracts in `@seo/contracts`, using the
existing document types as the shared interchange. No free patches, no free tool
calling, no free text between agents.

Motivation:

- The codebase already uses this exact pattern: AI boundaries return strict JSON,
  code validates (`isValidCompositionPlan`, `validateCompositionSlotFills`,
  `isValidCanonicalDoc`) and applies deterministically.
- The W10 policy explicitly forbids autonomous tool loops and agent-to-agent
  delegation (`docs/w10-magic-roadmap.md`).
- One shared artifact (`CanonicalDocument`) prevents each role from inventing its
  own document shape.

Proposed contract sketch (not implemented yet):

```ts
// packages/contracts/src/designer.ts (new)
export interface DesignBrief {
  projectId: string;
  intent: string;
  format: 'article' | 'landing_page' | 'email' | 'fragment';
  baseRevision?: string;
  constraints?: { tone?: string; language?: string; targetLength?: number };
}

export interface DesignerPlan {
  version: 1;
  format: DesignBrief['format'];
  designSystemRef?: CanonicalDesignSystemRef;
  steps: DesignerStep[];
}

export type DesignerStep =
  | { kind: 'writer.freeText'; task: FreeTextTask }
  | { kind: 'writer.fillSlots'; task: SlotFillTask }
  | { kind: 'composer.structure'; task: StructureTask }
  | { kind: 'designer.review'; criteria: ReviewCriterion[] };

export interface AgentResult {
  role: 'writer' | 'composer';
  document: CanonicalDocument;
  slots?: CompositionSlotMap;
  filled?: string[];
  unfilled?: string[];
  runSummary?: WriterRunSummary;
}

export interface DesignerReview {
  ok: boolean;
  issues: string[];
  finalDocument?: CanonicalDocument;
}
```

`FreeTextTask`, `StructureTask` and `SlotFillTask` are bounded wrappers that map
onto the existing `WriterInput`, `CompositionPlannerInput` and
`CompositionSlotFill[]`.

Why not events or patches: a single Designer run has a bounded, sequential step
list that is deterministically validatable. Events and patches only become
useful for true multi-run async agent collaboration, which is a later phase.

## 7. Orchestration model

A bounded Designer service with deterministic dispatch and one explicit AI
boundary, modelled on the existing Writer graph. Not a free tool loop.

1. `DesignerService.interpret(brief)` calls the AI boundary (Zod-validated) and
   returns a `DesignerPlan`. Honest failure codes mirror the existing writer
   planner: `not_configured | ai_error | invalid_output`.
2. `DesignerService.execute(plan, brief)` runs the `DesignerStep[]` sequentially
   and calls existing services via dependency injection:
   - `writer.freeText` -> Writer Engine in proposal mode (no-op
     `WriterPersistence`).
   - `composer.structure` -> `CompositionService` skeleton (no copy).
   - `writer.fillSlots` -> the reclassified slot filler plus
     `applyCompositionSlotFills`.
3. `DesignerService.review(results)` validates deterministically
   (`isValidCanonicalDoc`, `validateCompositionSlotFills`, structure guard,
   `evaluateSeo`), optionally with a later AI critique as a separate capability.
4. Result: a `FinalDocument: CanonicalDocument` as a proposal. Never persisted
   directly.

Tool boundaries:

- The Designer's "tools" are typed service calls, not a dynamic registry.
  Enforced through `DesignerDependencies`, mirroring `WriterRunDependencies`.
- No agent-to-agent free communication. Designer is the only caller of the
  specialists.

Jobs, retries, state, validation, approval, partial failure:

- Sync first. One HTTP route returning a proposal.
- Job-ready later: `container.jobStore.enqueue({ job_type: 'agent_design' })`.
  Reuse existing per-specialist retries and add a Designer step budget.
- Run state later in `seo_agent_runs` (mirrors `seo_writer_runs`,
  `supabase/migrations/20260101000019_writer_runs.sql`) because a Designer run is
  not the same object as a Writer run.
- Partial failure: per-step tagging and honest errors, like the phase tagging in
  `compositionService.ts`.

## 8. Ownership and concurrency

Single-writer principle: one artifact, one writer.

- Writer produces content blocks in Canonical.
- Composer produces structure blocks in Canonical.
- Designer only coordinates and reviews; it never edits directly.
- Any cross-boundary change goes through an explicit contract (a DesignerStep),
  never concurrent mutation.

Concurrency guard (H6):

```
baseRevision = hash(content_json)   (or a reliable revision)
on apply:
  current revision === proposal.baseRevision  ->  apply
  otherwise                                   ->  STALE_PROPOSAL, re-generate
```

A `baseRevision` is needed because the Designer may work on a document while the
human is editing it. This matters as soon as apply is exposed.

## 9. Human-in-the-loop

The Editor remains the only human control layer:

```
Designer / agents
       v
 proposed changes
       v
     Editor
       v
  accept / edit / reject
       v
 ContentService.write
```

- No agent silently overwrites a user's manual design. There is always an
  explicit approval or persistence flow.
- One proposal per run, one approval (H7). The user sees a preview and chooses
  Accept / Edit / Reject. Per-step approval is internal state, not user UX.
- Reuse the existing patterns: Writer plan approval (`approval.ts`,
  `WriterPanel.tsx`) and Content AI edit review-before-apply
  (`ContentAiEditPanel.tsx`).
- Applying goes through `canonicalDocumentToEditorDocument` into the Editor and
  then the normal autosave/`ContentService.write` path.

## 10. Design Package

Project-owned, portable, versioned. Existing material:

- Design tokens: `CosmosDesign` in `seo_projects.settings.cosmos.design`.
- Structure: `CompositionPlan`, `CompiledComposition`, `CanonicalDocument`.
- Variants: `CANONICAL_BLOCK_VARIANTS`.
- Validators: `parseCosmosDesign`, `isValidCompositionPlan`,
  `isValidCanonicalDoc`.

Proposed schema:

```ts
export interface DesignPackage {
  version: 1;
  metadata: { id: string; name: string; description?: string; tags?: string[]; createdAt: string };
  designSystem: CosmosDesign;
  structure: CompositionPlan | null;
  componentVariants: Partial<Record<CanonicalCompositionType, string[]>>;
  assets?: DesignAssetRef[];
}
```

Classification:

- Canonical and safely exportable: block types, variants, layout intent,
  `CompositionPlan` structure, heading levels, whitelisted attrs.
- Project-specific (values, not structure): token values, language and tone, and
  assets.
- Problematic references:
  - `mediaId`/`src` are project-scoped and must never cross projects. Export as a
    `DesignAssetRef` without an ID; re-resolve on import.
  - Block `id` and `CanonicalDesignSystemRef.id` are regenerated or namespaced on
    import.
  - `SourceRef` is stripped.
- Versioning from the start: `version: 1` plus `isValidDesignPackage`. The
  package format does not need to know about a future marketplace.
- Safety: import only through the existing validators; never raw CSS or HTML;
  assets always checked against the target project.

Resolver decisions implemented in Phase 3 (`packages/contracts/src/designPackage.ts`):

- The package is a **complete design state**, not a proposal: no `baseRevision`,
  no review, never mutates `seo_content`. `DesignerProposal` stays the guarded,
  reviewable change envelope for one run.
- Shape: `{ kind: 'design_package', version: 1, metadata, document:
  CanonicalDocument, designSystem: CosmosDesign, plan?: DesignerPlan, assets?:
  DesignAssetRef[] }`.
- Structure is not duplicated: the canonical document is the authoritative state,
  so the sketched `structure: CompositionPlan` and `componentVariants` fields are
  omitted. The variant vocabulary is global contract data
  (`CANONICAL_BLOCK_VARIANTS`), not package data. `plan` is optional provenance
  and reuses the existing `DesignerPlan`.
- Export strips project-scoped `mediaId`/`src` and CMS `source`, recording a
  portable `DesignAssetRef` (`target` + alt/caption); `importDesignPackage`
  returns only a value that passes `isValidDesignPackage`.

## 11. Reuse map

| Component | Decision | Motivation |
|-----------|----------|------------|
| Writer Engine/graph/durable | reuse | Complete, tested, human-gated; add a proposal-mode seam via the existing `WriterPersistence` |
| Composition planner | reuse | Bounded AI boundary with retry and validation |
| `compositionPlan.ts` compiler | reuse | Pure and deterministic; owns structure |
| `compositionWriter.ts` and `agents/composition/writer.ts` | refactor | Reclassify as the Writer capability `writer.fillSlots` so Composer owns no copy |
| `compositionService.ts` | extend | Add a copy-free skeleton mode and pass the design-system reference |
| Canonical model and validators | reuse | Already the shared interchange and firewall |
| `tiptapAdapter.ts` | reuse | Existing round-trip conversion |
| `editorHandoff.ts` | extend | `editorDocumentToCanonical` is unused; wire it for agent/editor round-trips |
| `AIService` plus OpenAI provider and BYOK | reuse | Resolution order account -> project -> env is done |
| `CosmosService.getCosmosContext` | reuse | Existing prompt context |
| `resolveDesignSystem` / `designSystemCssVariables` | extend | Exist but have no production caller; connect renderer, editor and Designer |
| `CanonicalRenderer` | reuse | Pure; will receive the resolved DesignSystem |
| `ContentService.write` | reuse | Only persistence choke point; never bypass |
| `JobStore` plus worker | reuse/extend | New `agent_design` job plus run state |
| HITL patterns | reuse | Proven accept/reject flows |
| `evaluateSeo`, canonical validators | reuse | Deterministic review |
| `seo_writer_runs` run model | reuse/extend | Template for a generic `seo_agent_runs` |
| Designer contracts, `DesignerService`, Design Package | new | Do not exist yet |
| MCP | reuse later | Second mouth on the same services |

## 12. Open items

No blocking decisions remain for the architecture. These are implementation
details for the later brief:

- Exact `baseRevision` source: `content_json` hash versus a revision column.
- Whether `seo_agent_runs` is a new table or an evolution of the writer run
  model.
- Designer step budget numbers and max LLM calls.
- The exact new filename for the reclassified slot filler (H9).
- Whether the design-system wiring lands in the same phase as Designer or one
  phase earlier.

## 13. Recommended implementation phases

Phase 1 — Contracts, proposal envelope, reverse bridge.

- `packages/contracts/src/designer.ts`: `DesignBrief`, `DesignerPlan`,
  `DesignerStep`, `AgentResult`, `DesignerReview` plus validators.
- Wire `editorDocumentToCanonical` on a real production path with tests.
- Add the `baseRevision` proposal envelope. Tests only, no behavior change.

Phase 2 — Designer orchestration (synchronous).

- `DesignerService` that builds a `DesignerPlan` and dispatches steps to the
  existing Writer Engine (proposal mode) and `CompositionService`.
- Reclassify the composition slot filler as `writer.fillSlots`.
- Wire `resolveDesignSystem` into `CanonicalRenderer`, the editor canvas and the
  Designer.
- One REST route returning a proposal, one approval. Nothing persisted.

Phase 3 — Design Package v1.

- `DesignPackage` schema, `isValidDesignPackage`, export/import with media and ID
  hygiene. Project-owned but portable.

Phase 4 — Durable agent runs.

- `agent_design` job type plus `seo_agent_runs`, step budgets, retries,
  approval interrupt, honest partial failure with `details.phase`.

Phase 5 — Designer UI, MCP, docs.

- Intent brief in the Content Studio, plan review, preview via
  `CanonicalRenderer`, explicit accept to the Editor.
- MCP as a second mouth on `DesignerService`.
- Update `roadmap.md` and `content-studio-roadmap.md` (currently silent on
  canonical/composition/Cosmos).

## 14. Documents to update when implementation starts

- `roadmap.md`.
- `docs/content-studio-roadmap.md`.
- `docs/w10-magic-roadmap.md` (cross-reference the Designer boundary).

## 15. Status / progress

Living status. Section 13 is the single source of truth for **what the phases
are**; this section is the single source of truth for **where we are**. Do not
add a second progress document (no `progress.md`); update this section instead.

### 15.1 ADR phase status

| ADR phase (§13) | Status | Evidence |
| --- | --- | --- |
| Phase 1 — Contracts, proposal envelope, reverse bridge | Done | `0531639` |
| Phase 2 — Designer orchestration (synchronous) | Done | `68ad5d9`, `d442d92`, `791c763`, `f88d4e6`, `172dd7b` |
| Phase 3 — Design Package v1 | Done | `ff652a6` |
| Phase 4 — Durable agent runs | Done | `ff61c47` (Part 1), Part 2 (worker execution, status API, reconciliation) |
| Phase 5 — Designer UI, MCP, docs | In progress — 5.1, 5.2, 5.3, 5.3.1 and 5.3.2 done | 5.1 Designer UI run foundation and 5.2 edit review + explicit apply (`apps/web/src/views/Designer.tsx`, `apps/web/src/components/designer/useDesignerRun.ts`); 5.3 Visual Design domain contract (`packages/contracts/src/visualDesign.ts`), 5.3.1 asset selection (`packages/contracts/src/visualAssetSelection.ts`) and 5.3.2 visual intent + proposal provenance (`apps/api/src/agents/designer/plannerPrompt.ts`, `apps/api/src/services/designerService.ts`); MCP and docs pending |

ADR Phase 2: DONE
  ├─ 3.1 done
  ├─ 3.2 done
  ├─ 3.3 done
  └─ 3.4 done

ADR Phase 3: DONE
  └─ Design Package v1 (portable state + export/import)

ADR Phase 4: DONE
  ├─ Part 1 (durable agent runs) done
  └─ Part 2 (worker execution, status API, reconciliation) done

ADR Phase 5: IN PROGRESS (5.1, 5.2, 5.3, 5.3.1 and 5.3.2 done; MCP and docs pending; do not mark Phase 5 complete)
  ├─ 5.1 Designer UI run foundation done: the new `/p/:projectId/designer` view
  │    submits one supported AgentRun input (intent, creation) to
  │    POST /designer/runs and follows that run through queued -> running ->
  │    succeeded | failed via GET /designer/runs/:runId. The project-scoped run
  │    bookmark is restored and polling resumed on mount, and the succeeded
  │    `DesignerProposal` is shown as a proposal only (no apply/save/publish).
  ├─ 5.2 Designer review + explicit apply done: the same view has Create new and
  │    Edit existing modes. An edit run is submitted against the selected
  │    document's server-derived revision (POST /designer/runs with `content_id`;
  │    the contract forbids sending `base_revision` alongside it). The succeeded
  │    proposal is reviewed beside the current saved document, and is written only
  │    through the existing `POST /content/:contentId/designer/apply`, which
  │    re-checks the revision and refuses a stale proposal (409 `stale_proposal`).
  │    No client-side save; reject is local and never touches saved content. This
  │    satisfies the §13 "review + explicit accept to the Editor" intent via the
  │    existing safe apply capability rather than a new endpoint.
  ├─ 5.3 Visual Design domain done: visual reasoning is its own Designer domain
  │    with a proposal contract, not an informal duty of the orchestrator.
  │    `packages/contracts/src/visualDesign.ts` defines a pure
  │    `visual_design_proposal` (operations over canonical block ids) plus a
  │    total, deterministic `applyVisualDesignProposal` that folds a validated
  │    proposal into a `CanonicalDocument`. It references existing project media
  │    by id (resolved metadata only, never bytes) and supports only operations
  │    the canonical model already expresses (`select_asset`, `set_variant`), so
  │    no arbitrary CSS/background/bytes can enter. Conflicts (unknown target,
  │    non-image target for an asset, missing asset, unsupported variant,
  │    duplicate operation) fail explicitly - no silent overwrite. The Designer
  │    plan gains a `visual.apply` step kind and the `visual` role
  │    (`DESIGNER_DOMAINS` = layout, content, visual), and `DesignerService`
  │    wires the capability through `MediaService` listing. It remains a proposal
  │    that composes into `DesignerProposal`: no second persistence path, no
  │    auto-apply, and the existing review/apply safety is unchanged.
  ├─ 5.3.1 Visual asset selection done: the Visual domain can now choose *which*
  │    existing asset fits a document instead of only composing a named one.
  │    `packages/contracts/src/visualAssetSelection.ts` derives each image
  │    block's surrounding text context, ranks the project's existing assets
  │    over metadata that actually exists (filename, alt text, caption, MIME,
  │    dimensions, usage), and returns a deterministic selection - or an
  │    explicit no-suitable-asset result, never a guess. One asset is never
  │    reused across blocks; unsupported MIME types and cross-project assets
  │    cannot be selected. `visualDesignProposalFromSelections` feeds the
  │    selections into the same `visual_design_proposal` pipeline, and the
  │    `visual.apply` task accepts either explicit `operations` or a `select`
  │    request (exactly one). No media index was added: `seo_media` is neither
  │    lexically indexed nor embedded, so selection reuses the existing
  │    project-scoped `MediaService.list`; `DesignerService` matches in memory
  │    and still persists nothing (selection reaches the existing review/apply
  │    path only).
  ├─ 5.3.2 Visual intent done: ordinary Designer intent can ask for visual work.
  │    The LLM planner prompt offers `visual.apply` with an open `select: {}`
  │    task only - the model is told never to name an asset, media id, filename
  │    or image block id, and the plan contract rejects unknown keys that would
  │    invite one - so the Visual domain resolves targets and assets itself.
  │    `DesignerService` keeps the validated visual proposal on
  │    `DesignerProposal.visual` (bounded `rationale` plus `unmatched` targets)
  │    strictly as explanation: `document` stays the source of truth, apply
  │    never depends on it, and the Designer UI shows the selections and
  │    unmatched targets read-only (no new endpoint, no visual editor).
  └─ MCP as a second mouth and the roadmap docs: pending.

Phase 2 is complete: the last §13 Phase 2 bullet — wiring `resolveDesignSystem`
into `CanonicalRenderer`, the editor canvas and the Designer — landed as chat
step 3.4. Chat steps are a working breakdown of ADR Phase 2; they are **not**
ADR phases.

Phase 3 is complete: `DesignPackage` v1 exists in
`packages/contracts/src/designPackage.ts` with strict validation, deterministic
serialization, export/import with media/ID hygiene, and a pure
proposal-to-package adapter. It is a portable design *state*, not a proposal;
see §10 for the resolved interpretation.

### 15.2 Chat sub-phase log (working breakdown of ADR Phase 2)

The `3.x` labels were used during implementation. `3.x` is **not** ADR Phase 3.
ADR Phase 3 is Design Package v1 (now complete; see §15.1). Do not equate them.

| Chat step | Scope | Status | Commit(s) |
| --- | --- | --- | --- |
| 3.1 | `DesignerIntent` contract + deterministic planner seam | Done | `d442d92` |
| 3.2 | `writer.revise` capability + LLM Designer planner + bounded planner context | Done | `791c763` |
| 3.3 | Public `POST /api/projects/:projectId/designer/intent` (proposal-only) | Done | `f88d4e6` |
| 3.4 | §13 Phase 2 residual: design-system wiring | Done | `172dd7b` |

What 3.4 did:

- One resolution path. `effectiveDesignSystem(value?)` in `@seo/contracts` is the
  single entry point: it accepts a resolved system, a full Cosmos config, raw
  Cosmos design input or nothing, and delegates all expansion to
  `resolveDesignSystem`. `canonical.ts` adds `withDesignSystemRef`, and
  `editorDocumentToCanonical(doc, meta?)` now carries metadata through.
- API records the identity. `getCosmosContext` exposes `designSystemRef`, and
  `CompositionService` / `DesignerService` stamp it onto the produced document
  as `meta.designSystem` — an identity ref (`{ id: 'cosmos' }`) only, never
  token values.
- Web renders through one path. A new `DesignSystemProvider` / `useDesignSystem`
  reads `GET /projects/:id/cosmos` and resolves it once; `CanonicalRenderer` and
  the `RichTextEditor` page canvas consume that context and emit
  `data-cosmos-design-system`, so preview and editing cannot disagree for the
  same canonical input.
- Fallback preserved. With no Cosmos config (or on a load error) every consumer
  falls back to `DEFAULT_DESIGN_SYSTEM`, and documents without the field stay
  compatible.

Verification: contracts 255, API 1460, web 278 tests green; `@seo/contracts`
build and all three package typechecks green.

ADR Phase 3 — Design Package v1 (summary):

- Shape: `{ kind: 'design_package', version: 1, metadata, document,
  designSystem, plan?, assets? }` in `packages/contracts/src/designPackage.ts`.
  It is a portable design *state*, not a proposal.
- Relationship: embeds a validated `CanonicalDocument` (authoritative state) and
  `CosmosDesign` token values; `document.meta.designSystem` stays an identity
  ref; `DesignerPlan` is reused as optional provenance. The `DesignerProposal`
  envelope is unchanged.
- API: `isValidDesignPackage`; `exportDesignPackage` (deterministic JSON);
  `importDesignPackage` (typed rejection, unsupported versions never
  reinterpreted); `portableDesignDocument` / `toPortableDesignPackage`
  (media/ID and `source` hygiene); `designPackageFromProposal` (pure Designer
  adapter at the proposal boundary).
- Safety: export strips project-scoped `mediaId`/`src` and CMS `source`,
  recording portable `DesignAssetRef`s; import returns only a value that passes
  canonical plus package validation.

Verification: contracts 275, API 1460, web 278 tests green; `@seo/contracts`
build and all three package typechecks green.

ADR Phase 4 — Durable agent runs (Part 1 done, summary):

- Scope: the durable submission boundary only. Execution (the `agent_design`
  worker executor), retries and the run status API are Part 2.
- Contract: `packages/contracts/src/agentRun.ts` (dependency-free, hand-rolled
  guards) defines `AgentRun`, the `queued | running | succeeded | failed`
  lifecycle, the discriminated `AgentRunInput` (plan or intent, reusing the
  existing `DesignerPlan`/`DesignerIntent`/`DesignerProposal` guards), and a
  bounded `AgentRunError`. A `succeeded` run without a persisted result and a
  `failed` run without failure info are both rejected by the envelope validator.
- Persistence: `supabase/migrations/20260101000029_agent_runs.sql` adds
  `seo_agent_runs` mirroring the `seo_writer_runs` conventions (external
  `ar_<uuid>` run id, derived `account_id`, safe status CHECK, project-scoped
  RLS, updated-at trigger, never hard-deleted). The relationship to the
  execution queue is explicit and one-way: `job_id -> seo_sync_jobs` plus the
  run id in the job params. There is no second queue, worker or retry model.
- Submission: `AgentRunService.submitDesignRun` validates the input, enforces
  idempotency, persists a `queued` run and enqueues its `agent_design` job
  (provider `designer`, key `agent_design:<runId>`). `POST
  /api/projects/:projectId/designer/runs` (editor+) returns 202 with the stable
  run identity and initial status; it never runs the Designer synchronously.
- Idempotency: an optional client key, scoped per project by a partial unique
  index. A duplicate returns the existing run and never enqueues a second job;
  a job-enqueue failure marks the run `failed` with honest failure facts.

Verification: contracts 287, API 1495 tests green; `@seo/contracts` build and
all three package typechecks green. Migration smoke checks were added to
`scripts/db-migrate-local.sh`; they have not been executed in this environment
(no local PostgreSQL).

ADR Phase 4 — Durable agent runs (Part 2 done, summary):

- Execution: `agent_design` is registered in the shared executor registry and
  delegates to `AgentRunService.executeDesignRun`. The service claims the run
  (optimistic `queued -> running`, re-entering an already `running` run on job
  retry), runs the Designer through the same synchronous route paths (plan mode
  via `DesignerService.execute`, intent mode via `executeIntent` with the LLM
  planner), and only persists the validated `DesignerProposal` before flipping
  `running -> succeeded`. A terminal run is never re-executed; a duplicate
  delivery that loses the optimistic transition re-reads and returns rather than
  overwriting.
- Failure semantics: a structured, bounded `AgentRunError` is recorded only on
  the terminal attempt. A retryable failure that the job will retry leaves the
  run `running` so the worker's existing backoff requeues the same job; only a
  non-retryable failure or exhausted retries marks the run `failed`. The run
  retry decision reuses the job store's exact predicate
  (`jobErrorPayload(...).retryable && retry_count + 1 <= max_retries`).
- Status API: `GET /api/projects/:projectId/designer/runs/:runId` (viewer+) is
  read-only and project-scoped through the repository's bound read; a malformed
  run id is `400`, an unknown/foreign run is `404 agent_run_not_found`.
- Reconciliation: `AgentRunService.reconcileOrphanedRuns` adopts a `queued` run
  older than a 60s grace window whose `job_id` is still null (the crash between
  run insert and job association). It re-enqueues with the SAME run-derived key
  `agent_design:<runId>`, so it is repeat-safe and concurrent-safe; a conflict
  means an equivalent job already exists and is skipped (fail closed). The worker
  invokes it at startup and, throttled to once a minute, on the existing idle
  loop - no second scheduler.
- Out of scope (Phase 5): Designer UI, MCP, media re-resolution, new planner
  algorithms, generalized orchestration and budget enforcement.

Verification: contracts 287, API 1519 tests green; `@seo/contracts` build and
all three package typechecks green.

### 15.3 Order after Phase 2/3

1. ADR Phase 5 — Designer UI, MCP, docs.

Deferred hardening is not part of Phase 2 closure and does not block Phase 4:
the H9 slot-filler rename, bounding `DesignerIntentContext.selection`, and a
planner timeout/cost budget (currently `maxTokens` only).
