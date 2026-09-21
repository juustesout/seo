# Editor Context Foundation (R1.2)

Status: **Done.** This document is the implementation report for Phase R1.2. It
records the context contract, the ownership map, the revision/dirty sources, the
external-update seam and the limitations found while building it. R1.2 is the
prerequisite for the embedded Agent entry surface (R2.1) and for image insertion
(R3.1).

## 1. What R1.2 adds

One normalized, document-scoped editor context that future Editor-native
features consume instead of inspecting Tiptap or re-deriving identity, revision
and selection from scattered props.

- active project and content identity;
- the current local document in canonical form (when representable);
- an explicit, stable revision of the local document;
- an explicit dirty flag;
- a normalized selection snapshot (`none` / `cursor` / `text` / `node`) with the
  containing block's type, transient structural path and, only when it already
  exists, a block id;
- a controlled seam for applying a future external document result.

The element selection used by the composition sidebar is unchanged and remains a
separate, coarser projection. It is not the agent contract.

## 2. Files changed

New:

- `apps/web/src/components/content/editor/editorContext.ts` - contract types,
  `EMPTY_EDITOR_SELECTION` and the pure `buildEditorContextSnapshot`.
- `apps/web/src/components/content/editor/EditorContext.tsx` -
  `EditorContextProvider`, `useEditorContext`, `useEditorContextSnapshot` and the
  `applyExternalDocument` seam.
- `apps/web/src/components/content/editor/editorContext.test.ts` - pure builder
  tests.
- `apps/web/src/components/content/editor/EditorContext.test.tsx` - provider,
  selection and external-apply tests.
- `apps/web/src/components/content/useAutosave.test.ts` - dirty and debounce
  behavior tests.

Modified:

- `apps/web/src/components/content/editor/selection.ts` - added
  `readSelectionSnapshot`, reusing the existing path helpers instead of a second
  mapping implementation.
- `apps/web/src/components/content/editor/selection.test.ts` - snapshot cases.
- `apps/web/src/components/content/editor/index.ts` - exports.
- `apps/web/src/components/content/workspace/EditorWorkspace.tsx` - accepts a
  `context` prop and wraps the workspace in `EditorContextProvider`.
- `apps/web/src/components/content/workspace/EditorWorkspace.test.tsx` - harness
  passes the new `context` prop.
- `apps/web/src/components/content/useAutosave.ts` - value-driven debounce
  (`snapshotKey`) and an explicit `dirty`.
- `apps/web/src/views/Content.tsx` - passes identity/dirty/ready into the
  workspace, uses `auto.dirty`, and waits for the row that matches the open id.
- `docs/editor-native-designer-contract.md` - phase table and handoff.

## 3. Context contract

Location: `apps/web/src/components/content/editor/editorContext.ts`. It is a
web-only concern, so no backend or contract-package changes were made.

`EditorContextSnapshot`:

- `projectId: string` - stable.
- `contentId: string | null` - `null` for a brand-new, not-yet-persisted
  document.
- `ready: boolean` - false while the document is still loading/seeding.
- `document.canonical: CanonicalDocument | null` - the local document through the
  existing `canonicalFromEditorDocument` bridge; `null` when it cannot be
  represented (never guessed).
- `document.unrepresentable: boolean` - set when the bridge rejects the document.
- `document.revision: string | null` - explicit revision, `null` while not ready.
- `document.dirty: boolean` - explicit dirty state.
- `selection: EditorSelectionSnapshot` - one of `none`, `cursor`, `text`, `node`.

Stable vs transient: `projectId`, `contentId`, `revision` and `dirty` are
meaningful values; `selection.nodePath` is explicitly transient (a structural
path, not an identity) and `selection.blockId` is only ever copied from an
existing node attribute.

## 4. Selection model

`readSelectionSnapshot(editor)` in `selection.ts` normalizes the live ProseMirror
selection:

- no usable editor -> `{ type: 'none' }`;
- empty text selection -> `type: 'cursor'` with `from`/`to`;
- non-empty range -> `type: 'text'` with `from`/`to`;
- `NodeSelection` -> `type: 'node'` with the node's range;
- cursor/text also carry the nearest non-document ancestor's `nodeType` and
  `nodePath` (the insertion context), when one exists.

`blockId` is read from `node.attrs.id` and is never synthesised. No node in the
current schema carries an `id`, so today it is always absent - which is the
honest result, not a missing feature.

Selection stability:

- Opening the Intelligence Rail, a popover or invoking a toolbar action moves
  DOM focus but not the ProseMirror selection, so the snapshot stays valid.
- Focus leaving the editor does not clear the selection (an action outside the
  canvas may still act on it).
- The document changing maps or clears the ProseMirror selection; the provider
  re-reads it on every `selectionUpdate`.
- Switching documents recreates the editor instance, so the provider's
  subscription re-syncs to the new document. The view additionally waits for the
  row matching the open id, so a new identity can never be paired with the
  previous document's content or selection.

## 5. Revision and dirty sources

- Revision: the existing `contentRevisionOf` utility over the local Tiptap
  document. This is the same token the server derives from the persisted
  `content_json`, so it is the token a Designer apply guard compares.
- Dirty: the existing autosave baseline. `useAutosave` now returns `dirty`,
  computed from the same baseline it uses to decide whether to save, so the two
  cannot disagree.
- The context always describes the local, unsaved document (what the user sees),
  not the last persisted row. A future agent operation must therefore send the
  local canonical document and local revision, and rely on the revision guard.

## 6. External update boundary

`useEditorContext().applyExternalDocument({ canonical, expectedRevision,
source? })` is implemented. It:

- refuses while the context is not ready (`not-ready`) or the editor is gone
  (`no-editor`);
- refuses when `expectedRevision` no longer matches the local document
  (`stale-revision`);
- refuses a document that is not a valid `CanonicalDocument`
  (`unrepresentable`);
- otherwise converts canonical -> editor via `canonicalDocumentToEditorDocument`
  and writes it with `editor.commands.setContent(next, true)`.

Consequences, deliberately chosen:

- the change goes through a normal editor transaction, so Undo remains
  available;
- it emits an update, which flows through the existing `onDocChange` and
  autosave path - no second persistence system and no direct server write;
- dirty becomes true and the existing save flow persists the result through
  `ContentService`;
- selection is reset by the replacement rather than guessed at (the old
  positions are not meaningful in a new document).

This is a client-side pre-check. The authoritative guard remains the server's
`stale_proposal` (409) at apply time.

## 7. Ownership

| Concern | Owner |
| --- | --- |
| Active project/document identity | `EditorWorkspace` / `Content` view |
| Current editor instance | Editor implementation (`RichTextEditor`) |
| Canonical local document | Editor state boundary (`Content` + `useAutosave`) |
| Selection snapshot | `EditorContextProvider` (`readSelectionSnapshot`) |
| Revision calculation | Existing `contentRevisionOf` utility |
| Dirty state | Existing `useAutosave` baseline |
| Agent intent | Future embedded Agent surface (R2.1) |
| Agent execution | Existing Designer infrastructure |
| Document mutation | Existing editor update / persistence path |
| Durable run state | Existing backend run infrastructure |

## 8. R1 recon mismatches found

1. **Autosave did not reschedule on edits.** Commit `1ce8995` removed
   `makeSnapshot` from the debounce dependencies to stop a self-trigger loop,
   which also stopped edits from scheduling a save. Only the initial load (and
   explicit Save / status change) persisted. R1.2 restores per-change
   scheduling with a value dependency (`snapshotKey`) that status transitions do
   not change, so the loop cannot return. This is required for dirty state to be
   meaningful.
2. **Stale document window.** `useAsync` keeps the previous row while a new one
   loads, so the editor could briefly render the previous document under the new
   id. The view now waits for `detail.data.id === editingId` before rendering the
   editor, and the context reports `ready: false` until then.

## 9. Tests

Added: `useAutosave.test.ts` (5), `editorContext.test.ts` (3),
`EditorContext.test.tsx` (9), plus 5 selection cases in `selection.test.ts`.
They cover identity/revision/dirty/canonical context, not-ready behavior,
unrepresentable documents, all four selection kinds, no block-id invention,
selection not leaking across documents, and the external-apply outcomes (valid,
stale, unrepresentable, no-editor, not-ready).

Results: contracts build passes; `@seo/api` typecheck and 1563 tests pass;
`@seo/web` typecheck, 334 tests and production build pass.

## 10. Limitations

- The context is not reactive to external writes to `content_json`; it describes
  the local editor. Collaborative/multi-writer sync is out of scope.
- `blockId` is structurally available but unused, because no node carries an id.
- The context is not persisted and adds no schema; it is derived per render.
- The apply seam has no callers yet - R2.1/R3.1 are its first consumers.

## 11. Persistent block IDs

Not necessary. Nothing in R1.2 required durable identity: `nodePath` is
sufficient for the current context, and `blockId` remains an optional,
honestly-empty field. A persistent block id stays a schema/contract decision for
R3/R4, when location-aware insertion actually needs it.

## 12. Recommended next phase

**R2.1 - Embedded Agent Entry Surface.** It can now be built against
`useEditorContext()` (identity, local canonical document, revision, dirty,
selection, insertion context) and `applyExternalDocument`, without reopening
editor architecture. R2.1 must still not start image insertion, which remains
R3.1.
