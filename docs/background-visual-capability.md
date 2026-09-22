# Role-Aware Background Visual Capability (R4.4)

Status: **done**. This is the R4.4 contract and implementation report for the
third role-aware visual capability of the Editor-native Designer Agent. It sits
under Phase R4 (`docs/editor-native-designer-contract.md`) and builds directly on
the R4.1 visual-design foundation (`docs/visual-design-foundation.md`), the R4.2
section capability (`docs/section-visual-capability.md`), the R4.3 hero
capability (`docs/hero-visual-capability.md`) and the R3.1 image-insertion slice
(`docs/context-aware-image-insertion.md`).

Scope: **one role, fully integrated**. R4.4 makes `background` a real,
insertable role: it does not build a layout engine, a CSS `background-image`
system or a separate visual editor. It reuses the R4.1 vocabulary, the R3.1
operation envelope and the R4.2/R4.3 host pattern, and it refuses honestly when
the editor cannot represent the requested background.

The binding interpretation for this phase keeps three dimensions separate:

- **Visual role** - what the image is for (`background`).
- **Host region** - where it lives (`section` or `hero`), the R4.2/R4.3 targets.
- **Visual placement** - the layout (`full_bleed`), unchanged.

`section` and `hero` are **host regions**, not new `VisualPlacement` values. A
background is a real image block with `role: "background"`; it is never a CSS
mutation.

## 1. Purpose

R4.2 and R4.3 proved the role language for sections and heroes. R4.4 proves it
for the background: a user asks "Gebruik een rustige achtergrond." (or "Use a
calm background.") and gets a suitable existing image inserted into *the region
they meant*, with background fully integrated and no new page, selector,
run-status panel or route.

It answers three concrete questions:

1. What does "a background" mean given the existing document model?
2. How does the Editor hand a host region to the Agent without inventing a
   second document or a second selection system?
3. Which background placement is supported, and how are unsupported ones refused
   without silently downgrading into a section or hero image?

## 2. What a background host is

A background is **hosted** in the document's real structure, not a new
abstraction. Two host regions are recognized, reusing the R4.2 and R4.3 targets:

- a composition `section` container or heading-delimited region
  (`ImageInsertionSectionTarget`, `docs/section-visual-capability.md`);
- an explicit composition `hero` container or the heading-delimited page hero
  (`ImageInsertionHeroTarget`, `docs/hero-visual-capability.md`).

`ImageInsertionBackgroundTarget` is therefore a union of the section and hero
targets:

```ts
export const IMAGE_INSERTION_BACKGROUND_HOST_REGIONS = ['section', 'hero'] as const;
export type ImageInsertionBackgroundHostRegion =
  (typeof IMAGE_INSERTION_BACKGROUND_HOST_REGIONS)[number];
export type ImageInsertionBackgroundTarget =
  | ImageInsertionSectionTarget
  | ImageInsertionHeroTarget;
```

Both are addressed by **structural index paths** for one document snapshot only.
Paths are location hints, never durable block identities.

The only supported background **layout placement** is:

```ts
export const IMAGE_INSERTION_BACKGROUND_PLACEMENT = 'full_bleed';
```

so any other placement is refused rather than reinterpreted. The image the
Editor inserts stays a real image block (`insertMedia`, the R3.1 command); R4.4
never writes a `background-image` style.

## 3. Editor to backend contract

The Editor never invents a second document or selection system. For every image
request it sends exactly what R3.1/R4.2/R4.3 sent plus one optional hint:

- `target` - the real caret/selection (`cursor` / `text-selection` / `block`),
  unchanged;
- `sectionTarget?` - unchanged from R4.2;
- `heroTarget?` - unchanged from R4.3;
- `backgroundTarget?` - the host region the background request addresses, when
  one can be resolved;
- the existing bounded context (`revision`, canonical `document`, semantics).

`ImageInsertionContext` gained the optional `backgroundTarget` field
(`packages/contracts/src/imageInsertion.ts`), validated so that it must itself be
a well-formed `section` or `hero` target. The R3.1/R4.2/R4.3 target semantics are
untouched, which is why plain "Zet hier een passende afbeelding." and the section
and hero instructions keep working.

The Editor resolves the hint with a pure read of the live document
(`readEditorBackgroundTarget`):

- an explicit `compositionHero` the selection sits in -> that hero as the host
  region;
- otherwise, when the page-hero region and the enclosing section share a single
  top-level `anchorPath` (the hero *is* the section's first block) -> the hero
  host;
- otherwise the enclosing section, else the first hero/section found;
- no section and no hero -> no `backgroundTarget` (the backend then refuses
  honestly).

The backend is the single decision-maker for the role. `backgroundTarget` is
ignored for non-background roles, so the hint can be sent unconditionally without
changing the inline, section or hero paths.

## 4. Backend resolution and insertion

`ImageInsertionService` resolves the instruction through the shared R4.1 resolver
and, for role `background`:

1. requires the resolved placement to be `IMAGE_INSERTION_BACKGROUND_PLACEMENT`
   (`full_bleed`); anything else is refused as unsupported, never downgraded into
   a section or hero image;
2. picks the **host region** the request names (an explicit "section"/"hero"
   word, otherwise the Editor's `backgroundTarget` hint, otherwise the resolved
   `target`), then resolves it with `resolveSectionVisual` / `resolveHeroVisual`;
3. refuses when there is no host region, when the heading can no longer be found,
   or when the host already contains an image;
4. rebuilds the retrieval context from the resolved host: the host heading plus
   its bounded body/supporting copy, so ranking reasons about the region's
   identity, not only the selected sentence;
5. ranks existing project media through the unchanged R4.1 ranker (the
   `background` role defaults to the `atmosphere` intent) and returns the typed
   `insert_image` operation inside the normal R3.1 proposal envelope.

The operation carries `visual.role = "background"` with `placement: "full_bleed"`
and the resolved host region as its target, so the Editor knows the insertion is
anchored after the heading. The backend still never writes `seo_content`;
`DesignerService.apply` continues to refuse proposals carrying an `insertion`.

## 5. Insertion anchor and accessibility

The image lands **after the host heading, before its body copy**, exactly like an
R4.2 section or R4.3 hero image. The Editor re-validates `anchorPath` against the
live document and resolves it to a text position at the end of the heading's
content (a valid position for the existing `insertMedia` command), so:

- the heading is never replaced;
- the image lands on a valid block boundary;
- the change is one editor transaction, and `undo` removes exactly the image.

An anchor that is not a heading any more, or an out-of-range path, resolves to
null and the apply fails honestly (`unresolved-target`) instead of inserting
somewhere arbitrary.

**Background alt policy** follows R4.1: `background` is decorative, so it gets
**empty alt** (with no filename fallback). It is a real image block, not a CSS
`background-image`, so it stays selectable, removable and accessible in the
document model.

## 6. Editor surface (unchanged shape)

The inline candidate is the R3.1 surface, not a new panel:

- the candidate previews the image, shows the role label ("Background visual")
  and the intent in product language, and offers Insert / Cancel;
- confirmation is required; nothing is inserted automatically;
- a resolved background shows the same single undoable transaction as R3.1/R4.2/
  R4.3.

The embedded Agent admits an explicit background request even without an image
noun ("Gebruik een rustige achtergrond."), exactly as it already did for heroes,
so the role language is usable end to end; every other instruction keeps the R3.1
`isImageInsertionInstruction` gate, so ordinary text such as "Add a section"
still routes to the Designer run.

## 7. Honesty and accessibility

- **No host region -> no background**: `background_target_unresolved`, a
  clarification telling the user where to add or focus a section or hero.
- **An existing image in the host region is reported, not duplicated or
  replaced** (`background_image_already_present`).
- **An unsupported background placement is refused, never downgraded** into a
  section or hero image (`visual_placement_unsupported`, resolver reason
  `background_placement_unsupported`).
- **A background competing with another role in one request is a
  clarification**, not a silent pick.
- **Background alt is empty** (decorative), consistent with the R4.1 vocabulary.
- **Only existing project media** is sourced; nothing is generated or downloaded.

## 8. Error behavior

Product-facing codes surfaced through the existing Designer run envelope and
mapped to product copy by the embedded Agent:

| Code | Meaning | Editor outcome |
| --- | --- | --- |
| `background_target_unresolved` | No host region, or the heading is gone | Clarification: add/focus a section or hero and try again |
| `background_image_already_present` | The host region already contains an image | Neutral note: remove or replace it first |
| `visual_placement_unsupported` | A background placement other than `full_bleed` | Unsupported: only a full-width background image is offered |
| `image_insertion_no_candidate` | No existing asset matches the region | Honest "no suitable image" |
| `visual_intent_needs_clarification` | Plural / multi-image / ambiguous role | Short clarification question |
| `stale_editor_context` | Document changed since the request | Retryable error, no document change |

## 9. Persistence and routing

No persistence, no migration, no new route, no new panel. The background hint and
the resolved intent ride the existing R3.1/R4.1 operation envelope; the host
region is resolved per request from a snapshot and never stored as a durable
identity. The existing durable Designer run endpoint is reused unchanged.

## 10. Supported vs not

Supported now:

- role-aware *background* image insertion from an instruction, fully in the
  Editor;
- host regions: explicit `compositionSection` / `compositionHero` containers and
  heading-delimited section / page-hero regions;
- host-scoped retrieval (heading + bounded body/supporting copy), unchanged R4.1
  ranking with the `background` role defaulting to `atmosphere`;
- anchor-after-heading insertion as one undoable transaction;
- empty alt for the decorative background image;
- honest refusals and clarifications for every unresolved case.

Explicitly not supported (reported as such, not faked):

- CSS `background-image` mutation or any overlay treatment;
- a combined hero+overlay request, auto cropping / focal point, or responsive art
  direction;
- replacement of an existing image (including a background/section/hero image);
- choosing between multiple candidates ("another one");
- plural / multi-image insertion;
- background placement other than `full_bleed`;
- other visual roles as hosts (logo, icon, ...);
- generation, visual search, or any new graphics panel, page or route.

## 11. Handoff to the next briefing

R4.4 is done; R4.1, R4.2, R4.3 and R3.1 still work. "Gebruik een rustige
achtergrond." now inserts a real full-bleed background image inside the Editor,
while the section, hero and plain image instructions are unchanged. A named
hero/section becomes the background's host region; R4.3's
`hero_background_unsupported` outcome is gone. Recommended next steps, in
priority order, each fully integrating one capability and keeping every
invariant (three separate axes, honest refusal over guessing, pure ranking, one
role fully integrated at a time, no new persistence, no new route or detached
UI):

1. Replacement of an existing image block (the R4.1-resolved role becomes the
   replacement's role) - this also makes `hasImage` hosts replaceable.
2. Candidate choice ("show me another") reusing the same ranker and intent.
3. `logo` / `icon` hosts.

## 12. Implementation report

Files changed:

- `packages/contracts/src/imageInsertion.ts` + test -
  `IMAGE_INSERTION_BACKGROUND_HOST_REGIONS`, `ImageInsertionBackgroundHostRegion`,
  `ImageInsertionBackgroundTarget`, `IMAGE_INSERTION_BACKGROUND_PLACEMENT`,
  `backgroundTarget` on the context, role/target cross-checks.
- `packages/contracts/src/visualVocabulary.ts` + test - `background` is
  insertable.
- `packages/contracts/src/visualIntent.ts` + test - background resolution carries
  an optional `hostRegion`; background+overlay reported unsupported
  (`background_placement_unsupported`); background competing with another role is
  a clarification; R4.3 `hero_background_unsupported` removed.
- `apps/api/src/services/imageInsertionService.ts` + test - background host
  resolution (`resolveBackgroundTarget`) and host-scoped retrieval.
- `apps/web/src/components/content/editor/imageInsertion.ts` + test -
  `readEditorBackgroundTarget`, context hint, anchor-after-heading range
  resolution.
- `apps/web/src/components/content/workspace/embeddedAgent.ts` + test -
  background outcome copy, background candidate message, background
  wants-context gate.
- `apps/web/src/components/content/workspace/EmbeddedAgentEntry.test.tsx` -
  background end-to-end flow tests.
- `docs/background-visual-capability.md` (this file),
  `docs/editor-native-designer-contract.md`, `docs/visual-design-foundation.md`,
  `docs/section-visual-capability.md`, `docs/hero-visual-capability.md`.

Tests / checks:

- `pnpm --filter @seo/contracts build` + `test` (407).
- `pnpm --filter @seo/api typecheck` + `test`.
- `pnpm --filter @seo/web typecheck` + `test` (432) + production build.

Compatibility notes:

- "Zet hier een passende afbeelding.", "Geef deze sectie een passende
  afbeelding." and "Maak de hero sterker." are unchanged: the inline, section and
  hero paths ignore `backgroundTarget`.
- `backgroundTarget` is optional; existing contexts and operations remain valid.
- `background` moved from "resolved but not insertable" to "insertable". A
  named hero/section in a background request is now the host region instead of
  being reported unsupported; the only other behavioral change is that a
  background instruction now performs a real insertion instead of reporting
  `visual_role_unsupported`.
- No migration, no new table, no new route, no backend document write.
