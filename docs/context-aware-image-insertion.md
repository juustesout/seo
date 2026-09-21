# Context-Aware Image Insertion (R3.1)

Status: **Done.** The first Editor-native Designer action: the user asks for a
suitable image in the Content Editor, the Agent resolves the insertion location
from the current editing context, selects an existing project image, and the
Editor inserts it in place as one undoable change - without leaving the workspace
and without a separate Designer page, preview workflow or second editor.

This document is the contract and report for R3.1. It complements
`docs/editor-native-designer-contract.md` (product contract) and
`docs/editor-context-foundation.md` (R1.2) / `docs/embedded-agent-entry-surface.md`
(R2.1).

---

## 1. User flow

1. The user places the cursor in a paragraph (or selects text, or selects a
   block) and opens the in-editor Agent (Ctrl/Cmd+K or "Ask Agent").
2. They submit "Zet hier een passende afbeelding." (or an English/other Dutch
   natively supported variant).
3. The embedded Agent submits the request through the existing durable Designer
   run endpoint, now including a bounded, validated editor context.
4. The run resolves one existing project media asset and returns a typed
   `insert_image` operation inside the normal Designer proposal envelope.
5. The Agent surface shows a compact inline candidate: preview, alt text,
   optional source, and **Insert image** / **Cancel**.
6. The user confirms. The image is inserted at the resolved location through the
   existing editor transaction path (`insertMedia`), the document becomes dirty,
   and the normal autosave persists it.
7. Undo removes the insertion cleanly. No navigation, no review page, no second
   document state.

Insertion requires explicit confirmation; the Agent never inserts merely because
a candidate was found.

## 2. Supported instruction patterns

`isImageInsertionInstruction` (contracts) is a deterministic, inspectable
classifier:

- Names an image: `afbeelding`, `afbeeldingen`, `foto`, `foto's`, `fotografie`,
  `illustratie`, `plaatje`, `image(s)`, `picture(s)`, `photo(s)`,
  `illustration`, `graphic`.
- And does **not** ask for a different image job (`alt text`, `beschrijf`,
  `analyseer`, `beoordeel`, `review`, `wat staat er op`, ...).

The same function runs on the editor and the API, so the two cannot drift.

## 3. Context contract

`ImageInsertionContext` (packages/contracts/src/imageInsertion.ts) is the bounded,
serializable payload the Editor sends. It contains no Tiptap instance, DOM node or
unserializable runtime state:

| Field | Meaning |
| --- | --- |
| `revision` | Stable revision of the local document (same `contentRevisionOf` scheme the apply guard uses). |
| `document` | Canonical snapshot the location and text were derived from. Used to validate, never written by the backend. |
| `target` | Resolved insertion location (see §4). |
| `selectedText` | The user's selected text, when the target is a text selection. |
| `nearbyText` | Bounded surrounding copy (previous/current/next block). |
| `documentTitle` | From the canonical `meta.title`, when present. |
| `sectionHeading` | Nearest preceding heading, when one exists. |
| `language` | From the canonical `meta.language`, when present. |

Bounds: revision 200 chars, text 2000, nearby 600, title/heading 300, language 40,
whole context serialized 100 000 (`IMAGE_INSERTION_CONTEXT_MAX_CHARS`). The API
route validates the context with `isValidImageInsertionContext` and requires
`content_id` alongside it.

The context travels as `editor_context` on `POST /projects/:projectId/designer/runs`
(intent mode) and is carried opaquely through the durable run as
`intent.context.selection`; `DesignerService.executeIntent` recognizes it and
produces the insertion proposal.

## 4. Location resolution

`ImageInsertionTarget` is a location hint for one snapshot, never a durable block
identity:

- `{ kind: 'cursor', position }` - caret position.
- `{ kind: 'text-selection', from, to }` - text range.
- `{ kind: 'block', path }` - structural index path.

Editor side (`imageInsertionTargetFromSelection`):

- cursor -> `cursor`; text -> `text-selection`; non-image node -> `block`.
- No selection, or a selected **image**, yields no target: replacement of an
  existing image is out of scope for R3.1 and must not silently become a duplicate
  insertion.
- No target means the request is answered with a clarification ("Where should I
  place the image? ...") instead of inserting at an arbitrary position.

Before applying, the target is re-validated against the live document
(`resolveImageInsertionRange`); an unresolvable target fails honestly
(`unresolved-target`).

## 5. Semantic context extraction

`buildImageInsertionQuery` (contracts) builds the deterministic search query from
`selectedText`, then `sectionHeading`, then `nearbyText`, then `documentTitle`,
dropping empty parts and capping at 2000 chars. On the editor,
`readEditorImageSemantics` reads only the selected text, the previous/current/next
block text and the nearest preceding heading - never the whole document - and never
invents context when none exists.

## 6. Image sourcing

Only **existing project media** is sourced, through the existing
`MediaService.list` path (bounded to 200 rows). Nothing is generated or downloaded
and no URL is invented. Selection reuses the shared
`rankVisualAssetCandidates` / `selectImageInsertionCandidate` matcher, which ranks
only real metadata (alt, caption, filename), excludes assets already referenced by
an image block in the snapshot, and returns **null** below the relevance floor.
Candidates without a library reference (`assetId`) are refused at apply time
(`missing-asset`), so a broken image URL can never be inserted.

## 7. Typed insertion operation

```ts
type InsertImageOperation = {
  type: 'insert_image';
  target: ImageInsertionTarget;
  image: { assetId?; url; alt; caption?; credit?; sourceUrl?; width?; height? };
  rationale?;
};
```

It answers what is inserted, where, and with which metadata, and is validated
(`isValidInsertImageOperation`) before use. It is carried on the existing
`DesignerProposal` as `proposal.insertion` (the "Design Package" envelope), not as
free text.

## 8. Proposal and apply behavior

- Backend (`ImageInsertionService`): validates the instruction, requires a saved
  document, re-derives the stored revision, selects one candidate, and returns a
  proposal (never a write). `DesignerService.apply` **refuses** a proposal that
  carries an `insertion` (`designer_insertion_requires_editor`, 422) so a
  suggestion can never masquerade as an applied change.
- Editor: `EditorContextProvider.applyImageInsertion` applies the operation as one
  undoable transaction via the existing `insertMedia` command (the same command
  the media picker uses), so the image lands on a valid block boundary, unrelated
  content is untouched, and `undo` removes it cleanly. The document becomes dirty
  through the normal `onDocChange` + autosave path.
- Confirmation: the candidate is shown inline and applied only on **Insert image**.
  Cancel never mutates.

## 9. Revision / stale-context protection

- The request captures `contentId` and `revision`; the embedded Agent also keeps an
  epoch and document identity so a response for a document that is no longer open
  is ignored.
- The backend refuses a context whose revision no longer matches stored content
  (`stale_editor_context`, 409), before selecting an asset.
- The editor refuses to apply when the live document revision differs from the
  revision the request was generated against (`stale-revision`), with the message
  "The document changed while I was finding the image. Please run the request
  again." No silent three-way merge.

## 10. Error behavior

All failures are typed and surfaced in product language; backend messages (which
name internal steps) are never echoed.

| Situation | Result |
| --- | --- |
| No reliable location | Inline clarification; nothing sent/inserted. |
| Unsupported instruction | Classified as non-insertion; normal Agent path. |
| No matching image | `image_insertion_no_candidate` -> "I couldn't find a suitable image for this section." |
| Document changed | `stale_editor_context` (409) / `stale-revision` -> "The document changed ... run the request again." |
| Unsaved document | `image_insertion_requires_saved_document` -> "Save the document before asking for an image." |
| Apply via `/designer/apply` | `designer_insertion_requires_editor` (422). |
| Candidate without library reference | `missing-asset`; nothing inserted. |
| Unresolvable target at apply | `unresolved-target`; nothing inserted. |

## 11. Known limitations

- **No candidate choice.** One request yields one candidate. The inline result has
  Insert/Cancel, not "Choose another"; the shared ranker is deterministic and
  excludes already-used assets only within the document.
- **No image replacement.** Selecting an existing image is not an insertion target.
- **No generation, search provider or upload in this flow.** Only the existing
  project media library is used.
- **Text-coordinate targets.** `cursor`/`text-selection` positions are editor
  positions; the backend validates their shape but not their semantic mapping into
  the canonical document (the editor is the authority, and it re-validates).
- **Alt text comes from library metadata** (falling back to the filename); R3.1 does
  not rewrite alt text.
- **Dirty documents block the request** (the durable endpoint derives revision from
  stored content); the surface offers "Save now".

## 12. Next-phase opportunities (R3.2)

- Candidate choice / "Choose another" via a bounded exclude list on the context.
- Image replacement of a selected existing image block (case C in the brief) as an
  explicit replace operation.
- Upload/open the media library from the same inline result when no suitable image
  exists.
- Richer semantic context (project topic, knowledge) once it is available in a
  bounded, validated shape.

The broader visual-role vocabulary this slice would build on is defined by
**R4.1** in `docs/visual-design-foundation.md`.

## 13. Implementation report

Files changed:

- `packages/contracts/src/imageInsertion.ts` (new) - context, operation, validators,
  intent/query/selection helpers; `packages/contracts/src/imageInsertion.test.ts`.
- `packages/contracts/src/visualAssetSelection.ts` - `RankedVisualAssetCandidate` +
  `rankVisualAssetCandidates`, reused by `selectVisualAssets`.
- `packages/contracts/src/designer.ts` - `DesignerProposal.insertion` + validator.
- `packages/contracts/src/index.ts` - export `imageInsertion.js`.
- `apps/api/src/services/imageInsertionService.ts` (new) + test.
- `apps/api/src/services/designerService.ts` - intent routing + `apply` refusal.
- `apps/api/src/services/agentRunService.ts` - `editorContext` on intent submissions.
- `apps/api/src/http/routes/designer.ts` - `editor_context` on `/runs` + test.
- `apps/web/src/components/content/editor/imageInsertion.ts` (new) + test.
- `apps/web/src/components/content/editor/EditorContext.tsx` -
  `buildImageInsertionContext` + `applyImageInsertion`.
- `apps/web/src/components/content/workspace/{embeddedAgent.ts,useEmbeddedAgent.ts,EmbeddedAgentEntry.tsx,EmbeddedAgentStatus.tsx}`
  + tests.
- `docs/context-aware-image-insertion.md` (this file),
  `docs/editor-native-designer-contract.md`.

Tests / checks:

- `pnpm --filter @seo/contracts build` + `test` (348).
- `pnpm --filter @seo/api typecheck` + `test` (1576).
- `pnpm --filter @seo/web typecheck` + `test` (386), production build.
