# Role-Aware Section Image Capability (R4.2)

Status: **done**. This is the R4.2 contract and implementation report for the
first role-aware visual capability of the Editor-native Designer Agent. It sits
under Phase R4 (`docs/editor-native-designer-contract.md`) and builds directly on
the R4.1 visual-design foundation (`docs/visual-design-foundation.md`) and the
R3.1 image-insertion slice (`docs/context-aware-image-insertion.md`).

Scope: **one role, fully integrated**. R4.2 does not implement every visual
role; it turns the R4.1 foundation into one real, user-visible result - a
role-aware *section* image - end to end inside the Content Editor. One role
fully integrated beats ten half-working, and the other insertable roles keep
their R4.1 resolution and honest refusals.

## 1. Purpose

R4.1 gave the platform the language (role / intent / placement) and a conservative
resolver. R4.2 proves that language is not shelf-ware: a user asks
"Geef deze sectie een passende afbeelding." (or "Give this section a suitable
image.") and gets a suitable existing image inserted into *the section they meant*,
with no new page, selector, run-status panel or route.

It answers three concrete questions R4.1 left to the host side:

1. What is "this section" in the actual document model?
2. How does the Editor hand a section to the Agent without inventing a second
   document or selection system?
3. Where does the image land, and how do dirty-state / undo / honesty stay intact?

## 2. What a section is

A section is the document's real structure, not a new abstraction. Two shapes are
recognized, in `packages/contracts/src/sectionVisual.ts`:

- an explicit composition `section` container (Editor node `compositionSection`),
  or
- a **heading-delimited region**: a heading plus its following sibling blocks
  until the next heading of the same or higher level.

Both are addressed by **structural index paths** for one document snapshot only.
Paths are location hints, never durable block identities - the same rule R3.1
uses for a cursor/block target.

A section target (`ImageInsertionSectionTarget`) carries:

- `sectionPath` - the addressed section (the container block, or the heading
  block that starts a region);
- `anchorPath` - the heading block the image is inserted after;
- `heading?` - bounded resolved heading text, as a context hint only.

`resolveSectionVisual(document, target)` is pure, deterministic and dependency
free. It returns null when the anchor is not a heading, when an explicit section
path does not contain the anchor, or when the heading is empty - so the caller
asks instead of guessing. It also reports `hasImage` (including an image inside
an explicit section) so the Agent never silently adds a second image.

## 3. Editor to backend contract

The Editor never invents a second document or selection system. For every image
request it sends exactly what R3.1 sent plus one optional hint:

- `target` - the real caret/selection (`cursor` / `text-selection` / `block`),
  unchanged;
- `sectionTarget?` - the section the selection currently sits in, when one can be
  resolved;
- the existing bounded context (`revision`, canonical `document`, semantics).

`ImageInsertionContext` gained the optional `sectionTarget` field
(`packages/contracts/src/imageInsertion.ts`), validated so that it must itself be
a well-formed `section` target. `imageInsertionTargetFromSelection` and the R3.1
target semantics are untouched, which is why plain
"Zet hier een passende afbeelding." keeps working.

The Editor resolves the hint with a pure read of the live document:

- selection inside an explicit `compositionSection` -> `sectionPath` = the
  section, `anchorPath` = its first heading child;
- otherwise -> the nearest preceding top-level heading (including a heading the
  cursor is on), `sectionPath` = `anchorPath` = that heading;
- no heading anywhere -> no `sectionTarget` (the backend then refuses honestly).

The backend is the single decision-maker for the role. `sectionTarget` is ignored
for non-section roles, so the hint can be sent unconditionally without changing
the inline path.

## 4. Backend resolution and insertion

`ImageInsertionService` resolves the instruction through the shared R4.1 resolver
and, for role `section`:

1. reads `context.sectionTarget` (falling back to a section-kind `target` for
   API callers);
2. refuses when there is no section, when the heading can no longer be found,
   when the section already contains an image, or when the resolved placement is
   not the one section host supported today (`contained`);
3. rebuilds the retrieval context from the resolved section: `sectionHeading` =
   the heading, `nearbyText` = the bounded section body after the heading
   (`SECTION_VISUAL_MAX_BODY_CHARS = 1200`), so ranking reasons about the whole
   section, not only the selected sentence;
4. ranks existing project media through the unchanged R4.1 ranker and returns the
   typed `insert_image` operation inside the normal R3.1 proposal envelope.

The operation target is the resolved section target, so the Editor knows the
insertion is anchored after the heading. The backend still never writes
`seo_content`; `DesignerService.apply` continues to refuse proposals carrying an
`insertion`.

## 5. Insertion anchor

The image lands **after the section heading, before the first content block**.
The Editor re-validates `anchorPath` against the live document and resolves it to
a text position at the end of the heading's content (a valid position for the
existing `insertMedia` command), so:

- the heading is never replaced (a section keeps its title);
- the image lands on a valid block boundary;
- the change is one editor transaction, and `undo` removes exactly the image.

An anchor that is not a heading any more, or an out-of-range path, resolves to
null and the apply fails honestly (`unresolved-target`) instead of inserting
somewhere arbitrary.

## 6. Editor surface (unchanged shape)

The inline candidate is the R3.1 surface, not a new panel:

- the candidate previews the image, shows the role label ("Section image") and
  the intent in product language, and offers Insert / Cancel;
- confirmation is required; nothing is inserted automatically;
- the section candidate copy names the outcome ("Insert it after the heading?");
- a resolved section shows the same single undoable transaction as R3.1.

## 7. Honesty and accessibility

- **Plural / multi-image requests are clarified, not guessed.** A plural or a
  quantity request ("images", "twee afbeeldingen") becomes
  `visual_intent_needs_clarification`; R4.2 inserts one image per request.
- **An existing section image is reported, not duplicated**
  (`section_image_already_present`).
- **No heading -> no section**: `section_target_unresolved`, a clarification
  telling the user where to put the cursor.
- **Section alt policy** follows R4.1: `section` is content-bearing, so it keeps
  descriptive alt text (with a filename fallback), and never invents empty alt.
- **Only existing project media** is sourced; nothing is generated or downloaded.

## 8. Error behavior

Product-facing codes surfaced through the existing Designer run envelope and
mapped to product copy by the embedded Agent:

| Code | Meaning | Editor outcome |
| --- | --- | --- |
| `section_target_unresolved` | No section target, or the heading is gone | Clarification: put the cursor under a section heading |
| `section_image_already_present` | The section already contains an image | Neutral note: remove or replace it first |
| `visual_placement_unsupported` | A section placement other than `contained` | Unsupported: only a contained section image is offered |
| `image_insertion_no_candidate` | No existing asset matches the section | Honest "no suitable image" |
| `visual_intent_needs_clarification` | Plural / multi-image / ambiguous role | Short clarification question |
| `stale_editor_context` | Document changed since the request | Retryable error, no document change |

## 9. Persistence and routing

No persistence, no migration, no new route, no new panel. The section hint and
the resolved intent ride the existing R3.1/R4.1 operation envelope; the section is
resolved per request from a snapshot and never stored as a durable identity. The
existing durable Designer run endpoint is reused unchanged.

## 10. Supported vs not

Supported now:

- role-aware *section* image insertion from an instruction, fully in the Editor;
- explicit composition sections and heading-delimited regions;
- section-scoped retrieval (heading + bounded body), unchanged R4.1 ranking;
- anchor-after-heading insertion as one undoable transaction;
- honest refusals and clarifications for every unresolved case.

Explicitly not supported (reported as such, not faked):

- other visual roles as hosts (logo, icon, ...); the `hero` host was added in
  R4.3 (`docs/hero-visual-capability.md`) and the `background` role in R4.4
  (`docs/background-visual-capability.md`);
- replacement of an existing image (including a section image);
- choosing between multiple candidates ("another one");
- plural / multi-image insertion;
- section placement other than `contained`;
- generation, visual search, or any new graphics panel, page or route.

## 11. R4.3 handoff

R4.2 is done, R4.1 and R3.1 still work. Recommended next steps, in priority
order, each fully integrating one capability and keeping every invariant (three
separate axes, honest refusal over guessing, pure ranking, no new persistence, no
new route or detached UI):

1. [Done in R4.3] Host block for `hero` - see `docs/hero-visual-capability.md`.
2. [Done in R4.4] Host blocks for full-bleed `background` - see
   `docs/background-visual-capability.md`.
3. Replacement of an existing image block (the R4.1-resolved role becomes the
   replacement's role) - this also makes `hasImage` sections replaceable.
4. Candidate choice ("show me another") reusing the same ranker and intent.
5. `logo` / `icon` hosts.

## 12. Implementation report

Files changed:

- `packages/contracts/src/sectionVisual.ts` (new) + test -
  `resolveSectionVisual`, `SECTION_BLOCK_TYPE`, `SECTION_VISUAL_MAX_BODY_CHARS`.
- `packages/contracts/src/imageInsertion.ts` + test - `section` target kind and
  validator, `sectionTarget` on the context, `IMAGE_INSERTION_SECTION_PLACEMENT`,
  role/target cross-checks.
- `packages/contracts/src/visualIntent.ts` + test - plural/multi clarification,
  section role resolution; `VisualIntentContext` no longer carries the target.
- `packages/contracts/src/index.ts` - export `sectionVisual.js`.
- `apps/api/src/services/imageInsertionService.ts` + test - section resolution
  and section-scoped retrieval.
- `apps/web/src/components/content/editor/imageInsertion.ts` + test -
  `readEditorSectionTarget`, context hint, anchor-after-heading range resolution.
- `apps/web/src/components/content/workspace/embeddedAgent.ts` + test -
  section outcome copy, section candidate message.
- `apps/web/src/components/content/workspace/EmbeddedAgentEntry.test.tsx` -
  section end-to-end flow tests.
- `docs/section-visual-capability.md` (this file),
  `docs/editor-native-designer-contract.md`.

Tests / checks:

- `pnpm --filter @seo/contracts build` + `test` (394).
- `pnpm --filter @seo/api typecheck` + `test` (1588).
- `pnpm --filter @seo/web typecheck` + `test` (407) + production build.

Compatibility notes:

- "Zet hier een passende afbeelding." is unchanged: the R3.1 inline path uses the
  same target and ignores `sectionTarget`.
- `sectionTarget` is optional; existing contexts and operations remain valid.
- No migration, no new table, no new route, no backend document write.
