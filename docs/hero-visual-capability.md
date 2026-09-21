# Role-Aware Hero Image Capability (R4.3)

Status: **done**. This is the R4.3 contract and implementation report for the
second role-aware visual capability of the Editor-native Designer Agent. It sits
under Phase R4 (`docs/editor-native-designer-contract.md`) and builds directly on
the R4.1 visual-design foundation (`docs/visual-design-foundation.md`), the R4.2
section capability (`docs/section-visual-capability.md`) and the R3.1
image-insertion slice (`docs/context-aware-image-insertion.md`).

Scope: **one role, fully integrated**. R4.3 is the first *hero*-specific
capability: it does not build a layout engine, a background-image system or a
separate hero editor. It reuses the R4.1 vocabulary, the R3.1 operation envelope
and the R4.2 host pattern, and it refuses honestly when the editor cannot
represent the requested hero.

## 1. Purpose

R4.2 proved the role language for sections. R4.3 proves it for the hero: a user
asks "Maak de hero sterker." (or "Make the hero stronger.") and gets a suitable
existing image inserted into *the hero they meant*, with one role fully
integrated and no new page, selector, run-status panel or route.

It answers three concrete questions:

1. What is "the hero" in the actual document model?
2. How does the Editor hand a hero to the Agent without inventing a second
   document or selection system?
3. Which hero placement is supported, and how are unsupported ones refused
   without silently downgrading into a section image?

## 2. What a hero is

A hero is the document's real structure, not a new abstraction. Two shapes are
recognized, in `packages/contracts/src/heroVisual.ts`:

- an explicit composition `hero` container (Editor node `compositionHero`) that
  contains a heading, or
- a **heading-delimited page hero**: the first top-level heading plus the copy
  that follows it until the next heading of any level.

Both are addressed by **structural index paths** for one document snapshot only.
Paths are location hints, never durable block identities.

A hero target (`ImageInsertionHeroTarget`) carries:

- `heroPath` - the addressed hero (the container block, or the heading block that
  starts a page hero);
- `anchorPath` - the heading block the image is inserted after;
- `nodeType` - canonical/editor host type, as a context hint;
- `placement` - fixed to `full_bleed`, the one hero treatment R4.3 hosts;
- `heading?` / `supportingText?` - bounded context hints only.

`resolveHeroVisual(document, target)` is pure, deterministic and dependency free.
It returns null when the anchor is not a heading, when an explicit hero path does
not contain the anchor, or when the heading is empty - so the caller asks instead
of guessing. It also reports `hasImage` (including an image inside an explicit
hero) so the Agent never silently duplicates or replaces a visual. The text/path
reads are shared with the section resolver through
`packages/contracts/src/canonicalText.ts`, so the two resolvers cannot drift.

## 3. Editor to backend contract

The Editor never invents a second document or selection system. For every image
request it sends exactly what R3.1/R4.2 sent plus one optional hint:

- `target` - the real caret/selection (`cursor` / `text-selection` / `block`),
  unchanged;
- `sectionTarget?` - unchanged from R4.2;
- `heroTarget?` - the hero the request addresses, when one can be resolved;
- the existing bounded context (`revision`, canonical `document`, semantics).

`ImageInsertionContext` gained the optional `heroTarget` field
(`packages/contracts/src/imageInsertion.ts`), validated so that it must itself be
a well-formed `hero` target. `imageInsertionTargetFromSelection` and the R3.1
target semantics are untouched, which is why plain "Zet hier een passende
afbeelding." keeps working.

The Editor resolves the hint with a pure read of the live document:

- selection inside an explicit `compositionHero` -> `heroPath` = that hero,
  `anchorPath` = its first heading child; otherwise the first hero container;
- no hero container -> the first top-level heading, `heroPath` = `anchorPath` =
  that heading (the page hero);
- no heading and no hero -> no `heroTarget` (the backend then refuses honestly).

The backend is the single decision-maker for the role. `heroTarget` is ignored
for non-hero roles, so the hint can be sent unconditionally without changing the
inline or section paths.

## 4. Backend resolution and insertion

`ImageInsertionService` resolves the instruction through the shared R4.1 resolver
and, for role `hero`:

1. reads `context.heroTarget` (falling back to a hero-kind `target` for API
   callers);
2. refuses when there is no hero, when the heading can no longer be found, when
   the hero already contains an image, or when the resolved placement is not the
   one hero host supported today (`full_bleed`);
3. rebuilds the retrieval context from the resolved hero: `sectionHeading` = the
   hero heading, `nearbyText` = the bounded supporting copy after the heading
   (`IMAGE_INSERTION_HERO_SUPPORTING_MAX_CHARS = 600`), so ranking reasons about
   the page identity and hero copy, not only the selected sentence;
4. ranks existing project media through the unchanged R4.1 ranker (the hero role
   already prefers landscape ~16:9) and returns the typed `insert_image`
   operation inside the normal R3.1 proposal envelope.

The operation target is the resolved hero target, so the Editor knows the
insertion is anchored after the heading. The backend still never writes
`seo_content`; `DesignerService.apply` continues to refuse proposals carrying an
`insertion`.

## 5. Insertion anchor

The image lands **after the hero heading, before its supporting copy**. The
Editor re-validates `anchorPath` against the live document and resolves it to a
text position at the end of the heading's content (a valid position for the
existing `insertMedia` command), so:

- the heading is never replaced (a hero keeps its title);
- the image lands on a valid block boundary;
- the change is one editor transaction, and `undo` removes exactly the image.

An anchor that is not a heading any more, or an out-of-range path, resolves to
null and the apply fails honestly (`unresolved-target`) instead of inserting
somewhere arbitrary.

## 6. Editor surface (unchanged shape)

The inline candidate is the R3.1 surface, not a new panel:

- the candidate previews the image, shows the role label ("Hero visual") and the
  intent in product language, and offers Insert / Cancel;
- confirmation is required; nothing is inserted automatically;
- a resolved hero shows the same single undoable transaction as R3.1/R4.2.

The embedded Agent admits an explicit hero request even without an image noun
("Maak de hero sterker.") so the role language is usable end to end; every other
instruction keeps the R3.1 `isImageInsertionInstruction` gate, so ordinary text
such as "Add a section" still routes to the Designer run.

## 7. Honesty and accessibility

- **A hero and a background in one request are unsupported, not reinterpreted.**
  The pair is reported as `unsupported` (`hero_background_unsupported`) rather
  than being flattened into a single full-bleed visual.
- **An existing hero image is reported, not duplicated or replaced**
  (`hero_image_already_present`).
- **No hero / heading -> no hero**: `hero_target_unresolved`, a clarification
  telling the user where to add or focus a hero.
- **An unsupported hero placement is refused, never downgraded** into a section
  image (`visual_placement_unsupported`).
- **Hero alt policy** follows R4.1: `hero` is content-bearing, so it keeps
  descriptive alt text (with a filename fallback), and never invents empty alt.
- **Only existing project media** is sourced; nothing is generated or downloaded.

## 8. Error behavior

Product-facing codes surfaced through the existing Designer run envelope and
mapped to product copy by the embedded Agent:

| Code | Meaning | Editor outcome |
| --- | --- | --- |
| `hero_target_unresolved` | No hero target, or the heading is gone | Clarification: add a hero/heading and try again |
| `hero_image_already_present` | The hero already contains an image | Neutral note: remove or replace it first |
| `visual_placement_unsupported` | A hero placement other than `full_bleed` | Unsupported: only a full-width hero image is offered |
| `image_insertion_no_candidate` | No existing asset matches the hero | Honest "no suitable image" |
| `visual_intent_needs_clarification` | Plural / multi-image / ambiguous role | Short clarification question |
| `stale_editor_context` | Document changed since the request | Retryable error, no document change |

## 9. Persistence and routing

No persistence, no migration, no new route, no new panel. The hero hint and the
resolved intent ride the existing R3.1/R4.1 operation envelope; the hero is
resolved per request from a snapshot and never stored as a durable identity. The
existing durable Designer run endpoint is reused unchanged.

## 10. Supported vs not

Supported now:

- role-aware *hero* image insertion from an instruction, fully in the Editor;
- explicit `compositionHero` containers and heading-delimited page heroes;
- hero-scoped retrieval (heading + bounded supporting copy), unchanged R4.1
  ranking with the hero landscape preference;
- anchor-after-heading insertion as one undoable transaction;
- honest refusals and clarifications for every unresolved case.

Explicitly not supported (reported as such, not faked):

- other visual roles as hosts (background, logo, icon, ...);
- replacement of an existing image (including a hero image);
- choosing between multiple candidates ("another one");
- plural / multi-image insertion;
- hero placement other than `full_bleed`; a hero+background combination;
- generation, visual search, or any new graphics panel, page or route.

## 11. Handoff to the next briefing

R4.3 is done; R4.1, R4.2 and R3.1 still work. "Maak de hero sterker." now inserts
a real hero image inside the Editor, and plain "Zet hier een passende
afbeelding." plus "Geef deze sectie een passende afbeelding." are unchanged.
Recommended next steps, in priority order, each fully integrating one capability
and keeping every invariant (three separate axes, honest refusal over guessing,
pure ranking, one role fully integrated at a time, no new persistence, no new
route or detached UI):

1. Host blocks for full-bleed `background`.
2. Replacement of an existing image block (the R4.1-resolved role becomes the
   replacement's role) - this also makes `hasImage` heroes/sections replaceable.
3. Candidate choice ("show me another") reusing the same ranker and intent.
4. `logo` / `icon` hosts.

## 12. Implementation report

Files changed:

- `packages/contracts/src/heroVisual.ts` (new) + test - `resolveHeroVisual`,
  `HERO_BLOCK_TYPE`, `HERO_EDITOR_NODE_TYPE`.
- `packages/contracts/src/canonicalText.ts` (new) - shared pure text/path reads
  used by both the section and hero resolvers.
- `packages/contracts/src/sectionVisual.ts` - refactored onto `canonicalText`.
- `packages/contracts/src/imageInsertion.ts` + test - `hero` target kind and
  validator, `heroTarget` on the context, `IMAGE_INSERTION_HERO_PLACEMENT`,
  `IMAGE_INSERTION_HERO_SUPPORTING_MAX_CHARS`, role/target cross-checks.
- `packages/contracts/src/visualVocabulary.ts` + test - `hero` is insertable.
- `packages/contracts/src/visualIntent.ts` + test - hero+background reported as
  unsupported.
- `packages/contracts/src/index.ts` - export `heroVisual.js`.
- `apps/api/src/services/imageInsertionService.ts` + test - hero resolution and
  hero-scoped retrieval.
- `apps/web/src/components/content/editor/imageInsertion.ts` + test -
  `readEditorHeroTarget`, context hint, anchor-after-heading range resolution.
- `apps/web/src/components/content/workspace/embeddedAgent.ts` + test - hero
  outcome copy, hero candidate message, explicit-hero wants-context gate.
- `apps/web/src/components/content/workspace/useEmbeddedAgent.ts` - use the
  wants-context gate.
- `apps/web/src/components/content/workspace/EmbeddedAgentEntry.test.tsx` - hero
  end-to-end flow tests.
- `docs/hero-visual-capability.md` (this file),
  `docs/editor-native-designer-contract.md`, `docs/section-visual-capability.md`.

Tests / checks:

- `pnpm --filter @seo/contracts build` + `test` (403).
- `pnpm --filter @seo/api typecheck` + `test` (1596).
- `pnpm --filter @seo/web typecheck` + `test` (421) + production build.

Compatibility notes:

- "Zet hier een passende afbeelding." and "Geef deze sectie een passende
  afbeelding." are unchanged: the inline/section paths ignore `heroTarget`.
- `heroTarget` is optional; existing contexts and operations remain valid.
- `hero` moved from "resolved but not insertable" to "insertable"; the only
  behavioral change is that a hero instruction (with an image noun, or an
  explicit "hero" word) now performs a real hero insertion instead of reporting
  `visual_role_unsupported`.
- No migration, no new table, no new route, no backend document write.
