# Context-Aware Visual Design Intent & Asset Roles (R4.1)

Status: **done**. This is the R4.1 contract and implementation report for the
shared graphics foundation of the Editor-native Designer Agent. It sits under
Phase R4 (`docs/editor-native-designer-contract.md`) and builds on the R3.1
image-insertion slice (`docs/context-aware-image-insertion.md`).

Scope: the *language and decision foundation* for visuals, not a graphics
editor. It gives the Agent, the Editor, the asset selector and future design
tools one vocabulary for what kind of visual belongs where, why it belongs
there, and how it behaves.

## 1. Purpose

R3.1 answered "insert a matching image here". R4.1 answers the broader and more
dangerous question behind every visual request: *what kind of visual is this,
what is it for, and how should it sit in the layout* - before any asset is
chosen or any document changes.

It exists so that image logic does not scatter ad hoc across the codebase. Every
new visual instruction, ranking tweak or future visual capability now speaks the
same typed language instead of hand-rolling its own notion of "hero" or
"background".

R4.1 deliberately stops at resolution and ranking:

- it resolves intent and refuses to guess when unsure;
- it can rank existing media for the resolved role;
- it does **not** implement every visual action (see section 12).

## 2. Three separate axes

The core design decision is that three things that people casually call "the
image type" are actually independent axes. They must not be collapsed into one
field, and must not be stored as intrinsic asset metadata.

| Axis | Type | Question it answers |
| --- | --- | --- |
| Asset role | `VisualAssetRole` | Where/how is the visual used? |
| Intent | `VisualIntent` | What is it meant to accomplish? |
| Placement | `VisualPlacement` | How does it participate in the layout? |

Why separate:

- The same photograph can be a hero today and a section image tomorrow. Roles
  are a property of the *placement*, not of the picture, so they never belong in
  the media record.
- Purpose and layout vary independently. A "reinforce" intent can be inline or
  side-by-side; a "background" role implies a full-bleed placement but is not
  the same thing as one.
- Future non-image visuals (diagrams, video posters) reuse the axes without
  redesigning the schema.

A second, narrower role set already exists for the canonical block that receives
an asset. To avoid a name clash it is called `VisualHostRole` (today only
`'image'`), while the design vocabulary owns `VisualAssetRole`.

## 3. Contract definitions

All types and validators are dependency-free in `@seo/contracts`.

### 3.1 Vocabulary (`packages/contracts/src/visualVocabulary.ts`)

```ts
type VisualAssetRole =
  | 'hero' | 'section' | 'inline' | 'background' | 'illustration'
  | 'icon' | 'logo' | 'decorative' | 'thumbnail' | 'avatar';

type VisualIntent =
  | 'explain' | 'reinforce' | 'atmosphere' | 'emphasis'
  | 'attention' | 'context' | 'brand' | 'decoration';

type VisualPlacement =
  | 'inline' | 'contained' | 'full_bleed' | 'side_by_side' | 'card' | 'overlay';

type VisualDesignIntent = {
  role: VisualAssetRole;
  intent: VisualIntent;
  placement?: VisualPlacement;
};
```

Helper contracts:

- `VISUAL_ROLE_DEFAULT_INTENT` / `VISUAL_ROLE_DEFAULT_PLACEMENT` - the default
  intent and placement for each role, used when the instruction is silent.
- `VISUAL_INSERTABLE_ROLES = ['inline', 'section', 'illustration', 'decorative']`
  - the roles the current editor model can actually host. Anything outside this
    set is honestly reported as unsupported rather than silently downgraded.
- `VISUAL_DECORATIVE_ROLES = ['decorative', 'background']`,
  `visualRoleRequiresDescriptiveAlt(role)`, `visualAltTextForRole(role, alt)` -
  decorative visuals get empty alt; content-bearing roles keep descriptive alt.
- `parseAspectRatio(value)` / `orientationOf(w, h)` / `visualAspectPreference` -
  aspect and orientation preferences used by ranking.

### 3.2 Resolution (`packages/contracts/src/visualIntent.ts`)

```ts
type VisualIntentResolution =
  | { status: 'resolved'; intent: VisualDesignIntent; query: string }
  | { status: 'needs_clarification'; candidates: VisualAssetRole[] }
  | { status: 'unsupported'; reason: string };
```

- `resolveVisualDesignIntent(instruction, context)` - the deterministic resolver
  (section 4).
- `visualRoleFromNodeType(nodeType)` - maps an Editor block type (heading,
  paragraph, ...) to a role hint.
- `isVisualIntentInsertable(intent)` - whether the role is in
  `VISUAL_INSERTABLE_ROLES`.
- `visualIntentQuery(intent, instruction)` - builds the media search query.

### 3.3 Carrying intent on an insert (`packages/contracts/src/imageInsertion.ts`)

`InsertImageOperation` gains an optional `visual?: VisualDesignIntent`.
`ImageInsertionContext` gains `targetNodeType?: string`, clamped by
`IMAGE_INSERTION_NODE_TYPE_MAX_CHARS`. A resolved visual intent therefore rides
on the existing R3.1 operation envelope; no new persistence was introduced
(section 9).

## 4. Resolution rules

`resolveVisualDesignIntent` is conservative, deterministic and pure. It never
calls a model and never mutates anything.

Order of resolution:

1. **Explicit role word wins.** A recognized role noun in the instruction maps
   directly (`hero`, `achtergrond`, `illustratie`, `icoon`, ...).
2. **Explicit intent/placement overrides the role default.** "Een rustige
   achtergrond" resolves role `background` with intent `atmosphere` and
   placement `full_bleed`.
3. **Editor target node type breaks role ties.** A cursor in a heading biases
   toward `hero`/`section`, a cursor in body copy toward `inline`.
4. **Multiple roles, or a purpose with no role, produce
   `needs_clarification`** with the explicit candidate roles. The Agent asks a
   short question instead of guessing.
5. **Nothing visual can be justified produces `unsupported`.** A request that is
   not visual at all is not silently turned into an image.
6. Generic "add an image" (no role) still resolves through the R3.1
   `isImageInsertionInstruction` path as `inline`.

This is the honesty rule applied to design: an unresolved request becomes a
question or a refusal, never a fabricated role.

## 5. Context inputs

Resolution may use, all bounded and validated:

- the Editor instruction text;
- the surrounding text and nearest preceding heading (R3.1 semantics);
- the target node type (`targetNodeType`) as a weak role hint;
- any explicit selection text.

Context can *inform* resolution but never fabricates a role on its own. Absent
context simply narrows the outcome toward `needs_clarification`.

## 6. Asset ranking

The shared ranker is extended, not replaced
(`packages/contracts/src/visualAssetSelection.ts`):

- `RankedVisualAssetCandidate` gains a `fit` score next to the existing subject
  `score`.
- `rankVisualAssetCandidates(query, candidates, { visual? })` accepts the
  resolved visual intent.
- Fit is computed **after and below** subject relevance: orientation match +2 /
  mismatch -1, aspect-ratio closeness +1, availability of alt/caption/dimensions
  +1.
- No existing asset metadata is invented; fit reasons only over real fields.
- With no `visual` option the ordering is exactly the R3.1 order, so existing
  callers are unaffected.

Behavior on the R3.1 path: `selectImageInsertionCandidate(context, candidates,
{ minScore?, visual? })` passes the intent through, and `selectVisualAssets`
reuses the same ranker so ranking rules live in one place.

## 7. Design Package integration

Visual intent is represented as a typed visual instruction on the existing
proposal/operation envelope, not as a new Design Package concept. The resolved
`VisualDesignIntent` is carried on the `insert_image` operation's `visual`
field, which the Design Package already transports as a typed proposal
operation. Structured intent is therefore preserved end to end without a new
document format, and the existing Design Package validators keep working.

## 8. Accessibility semantics

Validated in contracts and documented here:

- `decorative` and `background` roles are decorative: alt text is empty so
  screen readers skip them. Decorative visuals must never receive misleading
  alt text.
- content-bearing roles (`inline`, `section`, `illustration`, `hero`, `logo`,
  ...) require descriptive alt.
- `visualAltTextForRole` centralizes this so no call site re-decides it.
- A background intent cannot silently become a normal inline image: unsupported
  roles are refused before sourcing (section 10).

## 9. Persistence decision

No persistence and no migration.

Visual intent is a *usage* property, so it is derived per request and travels on
the transient operation. It is not written to `seo_media`, not added to the
asset record, and not stored as a new table, taxonomy or visual graph. R4.1
introduces no new route and no new panel.

## 10. Error behavior

Product-facing codes surfaced through the existing Designer run envelope:

| Code | Meaning | Behavior |
| --- | --- | --- |
| `visual_role_unsupported` | Resolved role not hostable yet (e.g. hero) | Refused before reading content; details `{ role }` |
| `visual_intent_needs_clarification` | Ambiguous role or purpose-only request | Agent asks which visual; details `{ roles }` |
| `visual_intent_unsupported` | Not a visual request | Honest refusal, no document change |
| `image_insertion_unrecognized_instruction` | R3.1 generic path also declined | Existing R3.1 copy |

On any of these the Editor shows a plain-language outcome and the document is
untouched.

## 11. Editor integration

The embedded Agent flow stays inside the Editor (no separate graphics UI):

- `readEditorImageSemantics` now reports `targetNodeType` as the role hint.
- The Agent shows the resolved role and intent in product language
  (`visualRoleLabel`, `visualIntentLabel`, `visualIntentMessage`) and a
  clarification prompt when needed.
- Decorative inserts show decorative-alt copy.
- Preview, insert and undo are unchanged from R3.1: one candidate, one undoable
  transaction via `insertMedia`.

## 12. Current supported capabilities and explicit limitations

Supported now:

- resolve role / intent / placement from an instruction plus context;
- ask for clarification when the role is ambiguous;
- refuse with a clear reason when unsupported or non-visual;
- rank existing project media for `inline`, `section`, `illustration`,
  `decorative` inserts, factoring orientation/aspect fit below subject match;
- carry the structured intent on the typed operation;
- default accessible alt handling per role.

Explicitly not supported (unimplemented, and reported as such):

- hero, background, logo, icon, thumbnail and avatar insertion (no host block);
- replacement of an existing image;
- choosing between multiple candidates ("another one");
- crop, focal point, responsive art direction, video, SVG, animation;
- generation, visual embeddings, computer vision or Qdrant visual taxonomies;
- advanced aesthetic ranking;
- any new graphics panel, separate visual editor or new route.

Status note: the "not supported" list above reflects R4.1. Since then three roles
became real hosts - `section` in R4.2 (`docs/section-visual-capability.md`),
`hero` in R4.3 (`docs/hero-visual-capability.md`) and `background` in R4.4
(`docs/background-visual-capability.md`); the rest still stand.

## 13. R4.2 handoff

Recommended next step: extend the *host* side so more resolved roles become
real. In priority order:

1. [Done in R4.3] Host block for `hero`; [Done in R4.4] full-bleed `background`
   (`docs/background-visual-capability.md`).
2. Replacement of an existing image block (the R4.1-resolved role becomes the
   replacement's role).
3. Candidate choice ("show me another") reusing the same ranker and intent.
4. `logo`/`icon` hosts for brand and inline affordances.

All of these must keep the R4.1 invariants: three separate axes, honest
refusal over guessing, pure ranking, no new persistence, and no new route or
detached UI. R3.1 remains the reference slice: one action, one understandable
result, in product language.

## 14. Implementation report

Files changed:

- `packages/contracts/src/visualVocabulary.ts` (new) + test - roles, intents,
  placements, validators, defaults, insertability, decorative/alt rules, aspect.
- `packages/contracts/src/visualIntent.ts` (new) + test - deterministic
  instruction+context resolver and uncertainty.
- `packages/contracts/src/visualAssetSelection.ts` + test - `VisualHostRole`
  rename, `fit` score, `VisualAssetRankingOptions`, options-aware ranking.
- `packages/contracts/src/imageInsertion.ts` + test - `visual` on the operation,
  `targetNodeType` on the context, intent-aware selection/alt.
- `packages/contracts/src/index.ts` - export the new modules.
- `apps/api/src/services/imageInsertionService.ts` + test - role-aware
  resolution and the new error codes.
- `apps/web/src/components/content/editor/imageInsertion.ts` + test -
  `targetNodeType` semantics.
- `apps/web/src/components/content/workspace/{embeddedAgent.ts,useEmbeddedAgent.ts,EmbeddedAgentStatus.tsx}`
  + tests - role/intent labels, clarification outcome, decorative-alt copy.
- `docs/visual-design-foundation.md` (this file),
  `docs/editor-native-designer-contract.md`.

Tests / checks:

- `pnpm --filter @seo/contracts build` + `test` (381).
- `pnpm --filter @seo/api typecheck` + `test` (1581).
- `pnpm --filter @seo/web typecheck` + `test` (394) + production build.

Compatibility notes:

- R3.1 image insertion is unchanged; ranking without a `visual` option keeps the
  exact previous order.
- Existing Designer runs and Design Packages remain valid; `visual` and
  `targetNodeType` are optional.
- No migration, no new table, no new route, no document mutation on resolution.
