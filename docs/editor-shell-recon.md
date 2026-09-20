# Phase R1.1 — Editor Shell Recon & Experience Foundation

Status: **recon complete + implementation brief**. No production code was changed.

Binding inputs:

- `docs/editor-native-designer-roadmap.md` (guiding brief, R1 = Editor Shell &
  Interaction Foundation)
- `docs/editor-native-designer-contract.md` (ADR Phase R0 product/UX contract)

Evidence taken at `HEAD 987d559` (`docs(editor-native): add R-series roadmap and
R0 product/UX contract`). Every claim below was read from source, not inferred.

Scope discipline for this phase: reconnaissance only. No new Editor shell was
built, no embedded Designer, no new routes, no backend/model changes, no
unrelated code touched. The only artifact is this document.

---

## 1. Executive summary

The Editor is already functional but its *shell* is not a product shell. It is a
stack of three separate toolbars, an internal composition sidebar, a 250px rail
holding five stacked panels, and a full-width knowledge section. Concretely:

1. Opening a document renders (top to bottom) `ContentEditorHeader`, an optional
   error banner, a knowledge-context checkbox, a writer toggle, an optional
   `WriterPanel`, then a two-column grid. The left column is `EditorShell`
   (which itself contains an Elements/Settings sidebar, an undo/redo toolbar and
   the canvas); the right column is a 250px aside with five panels; a full-width
   `KnowledgePanel` sits below the grid (`views/Content.tsx:644-815`).
2. **Three toolbars compete**: `ContentEditorHeader` (document actions),
   `EditorToolbar` (undo/redo/delete + a second save label),
   `ContentToolbar` (formatting + AI dropdown). Undo/redo is rendered twice and
   undo/redo/delete also exist implicitly through Tiptap.
3. **Naming collision**: the component called `EditorShell` is not the product
   shell. It is the composition canvas surface (element insert + selection +
   undo/redo). The R1 "Editor shell" does not exist yet.
4. **Active-block/selection state is trapped inside `EditorShell`** (internal
   `selectedElement`, `editor/EditorShell.tsx:25-27`). The parent `Content.tsx`
   does not subscribe to it (it passes no `onSelectionChange` at
   `Content.tsx:722`). A second, unrelated `hasSelection` boolean lives in
   `Content.tsx:143,289-299`.
5. **Autosave is solid and shared** (`useAutosave`: `saved | unsaved | saving |
   failed`, `useAutosave.ts:3,19-97`) but its status is displayed in two places
   (`ContentEditorHeader.tsx:75`, `EditorToolbar.tsx:102-113`).
6. **No preview exists.** The only non-editing render is the viewer branch, which
   shows the server-rendered `content_html` via `dangerouslySetInnerHTML`
   (`Content.tsx:620-628`), not the live document. `CanonicalRenderer` already
   renders a live `CanonicalDocument` and is used by Designer/Compose.
7. **No keyboard shortcuts at all** in the web app except one input's Enter
   handler (`views/Keywords.tsx:256-258`) and `popstate`
   (`App.tsx:140-144`). Selection is pointer-driven
   (`EditorCanvas.tsx:15-18`).
8. **Responsive is `lg:`-only inside the editor** (`EditorShell.tsx:96`,
   `EditorSidebar.tsx:23`, `Content.tsx:720`). There is no collapse/drawer and
   no app-level mobile navigation (`App.tsx:474` hides the sidebar below `md`
   with no replacement).
9. **AI surfaces are scattered across six places** (details in §5); there is no
   single reserved AI place.
10. **UI primitives are thin**: only `button`, `card`, `input`, `badge`,
    `textarea`, `table`, `page-header`. No tabs, dialog, dropdown, tooltip,
    toast, sheet, scroll-area. No toast/notification system exists.

The shell redesign must therefore (a) establish one document header, (b)
consolidate undo/redo/save into one place, (c) lift selection/active-block state
out of `EditorShell`, (d) reserve a single AI place, (e) add an in-editor preview
and a real publish/schedule action slot, and (f) add a keyboard baseline and
collapse behaviour, without adding routes or touching the backend.

---

## 2. Current architecture

### 2.1 Entry and route

The Editor is the `content` project view. `App.tsx:325` renders
`<Content projectId role initialContentId onOpenCalendar onOpenPublications />`.
`initialContentId` comes from the URL sub-segment (`parseRoute` `App.tsx:87-94`)
and is used by Compose deep-links (`App.tsx:327`). The view keeps the URL
`/p/:projectId/content[/:contentId]`; internal list/editor transitions do **not**
change the route (`goList` `Content.tsx:332-340`).

### 2.2 The editable branch render tree

`views/Content.tsx:644-815` (verified):

```
<div className="grid gap-3">
  Back-to-list button                                  Content.tsx:646-650
  err / notice banners                                 Content.tsx:652-659
  <ContentEditorHeader ... />                          Content.tsx:661-676
  autosave-failed banner                               Content.tsx:678-682
  aiError banner                                       Content.tsx:684-688
  knowledge-context checkbox (if aiConfigured)         Content.tsx:690-695
  writer toggle row                                    Content.tsx:697-709
  <WriterPanel /> (if writerOpen && editingId)         Content.tsx:711-718
  <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_250px]">   Content.tsx:720
    <div className="min-w-0">
      <EditorShell editor saveState>                   Content.tsx:722
        <ContentToolbar editor ai />                   Content.tsx:723-735
        <RichTextEditor ... />                         Content.tsx:736-751
      </EditorShell>
      aiBusy notice                                    Content.tsx:753-757
      <ContentAiPanel /> (if aiSuggestion)             Content.tsx:758-762
      aiEditBusy / aiEditError                         Content.tsx:763-772
      <ContentAiEditPanel /> (if aiEditProposal)       Content.tsx:773-782
    </div>
    <aside className="flex min-w-0 flex-col gap-3.5">  Content.tsx:784-810
      <AgentControls /> (if editingId)                 Content.tsx:785-796
      <SeoPanel /> (always)                            Content.tsx:797-806
      <ContentOutline /> (always)                      Content.tsx:807
      <MediaPanel /> (if editor)                       Content.tsx:808
      <IntelligencePanel /> (if editingId)             Content.tsx:809
    </aside>
  </div>
  <KnowledgePanel /> (always, full width)              Content.tsx:813
</div>
```

Inside `EditorShell` (`editor/EditorShell.tsx:94-113`):

```
<div className="flex min-h-[520px] flex-col ... lg:flex-row" data-testid="editor-shell">
  <EditorSidebar />        // lg 32%, min 240 / max 360; Elements | Settings tabs
  <EditorMain />           // flex-1 flex-col
    <EditorToolbar />      // Undo / Redo / Delete + save label
    <EditorCanvas>         // pointer-up selection
      {children}           // = ContentToolbar + RichTextEditor
```

### 2.3 The three toolbars + two side rails

| Region | Component | Contents |
| --- | --- | --- |
| Document header | `ContentEditorHeader` (`ContentEditorHeader.tsx:39-122`) | Title input, status badge, save badge, History/Save/Publish/Delete, slug, word count, status `<select>` |
| Canvas toolbar A | `EditorToolbar` (`editor/EditorToolbar.tsx:39-116`) | Undo, Redo, Delete-composition, save label |
| Canvas toolbar B | `ContentToolbar` (`ContentToolbar.tsx:109-167`) | Bold/Italic/Strike, H1-H4, lists, quote, code, link, rule, undo, redo, AI dropdown |
| Left rail | `EditorSidebar` (`editor/EditorSidebar.tsx:8-84`) | Elements/Settings tabs, element browser, insert hint, settings |
| Right rail | 250px `<aside>` (`Content.tsx:784-810`) | AgentControls, SEO, Outline, Media, Intelligence |
| Below grid | `KnowledgePanel` (`Content.tsx:813`) | Knowledge sources manager |

Undo/redo is therefore reachable from `EditorToolbar.tsx:72-91`,
`ContentToolbar.tsx:162-163`, and Tiptap's own keymap — three implementations of
one concept, none of them keyboard-shortcut driven.

### 2.4 State ownership

| State | Owner | Exposed via |
| --- | --- | --- |
| `editingId`, `creating`, list, detail | `Content.tsx` (`118-123,157`) | local render branches |
| Workspace doc/meta: `title,status,doc,targetKeyword,metaTitle,metaDescription,slug,savedAt` | `Content.tsx` (`125-133`) | passed to header/panels/autosave |
| `live` ref mirror | `Content.tsx:161-162` | autosave snapshot |
| Autosave status/baseline/saveNow | `useAutosave` (`useAutosave.ts:20-96`) | `auto.status`, `auto.setBaseline`, `auto.saveNow` |
| Editor instance | `Content.tsx:134` via `onEditor` | passed to shell/toolbar/media |
| `hasSelection` (boolean) | `Content.tsx:143,289-299` | toolbar AI enablement |
| `aiConfigured/aiBusy/aiError/aiSuggestion/aiSelRange` | `Content.tsx:138-144` | toolbar + panels |
| `aiEditBusy/aiEditError/aiEditProposal` | `Content.tsx:148-150` | bubble menu + panel |
| `writerOpen` | `Content.tsx:155` | writer row |
| `sidebarMode`, `selectedElement`, `insertHint` | `EditorShell` (`EditorShell.tsx:25-27`) | `data-*` only; `onSelectionChange` optional and unused by Content |
| `canvasMode` | `RichTextEditor` (`RichTextEditor.tsx:51`) | visual |
| Panel async state | each panel | local |

Key finding for the redesign: **the active element/block is not available outside
`EditorShell`**, even though `EditorShell` already accepts an
`onSelectionChange` callback (`EditorShell.tsx:23,32,47,63,77`). `Content.tsx`
does not pass it (`Content.tsx:722`). R3's location-aware image insertion will
need this state at workspace level.

### 2.5 Data flow

- **Document**: `RichTextEditor` creates Tiptap once (`useEditor`,
  `RichTextEditor.tsx:55-64`); every update lifts `getJSON()` via `onDocChange`
  (`:58-63`) into `Content`'s `doc` state; autosave serializes
  `{title,status,doc,keyword,metaTitle,metaDescription}` to a canonical string
  (`Content.tsx:200-201`) and persists through `commit` (`:205-227`), which runs
  `canonicalFromEditorDocument` as a guard (`:209`) before PATCH/POST.
- **Selection**: `readCanvasSelection(editor)` maps ProseMirror selection to
  `EditorSelection = { type, id?, path? } | null` (`selection.ts:30-46`,
  `types.ts:9-13`). `EditorShell` subscribes to `selectionUpdate`/`focus`
  (`EditorShell.tsx:68-85`) and to pointer-up (`EditorCanvas.tsx:15-18`).
  `Content` separately tracks `hasSelection` (`Content.tsx:289-299`).
- **AI**: two apply paths, both normal ProseMirror transactions so autosave and
  Undo keep working: legacy plain-text (`runAi`/`applyAi`,
  `Content.tsx:380-437`) and structured selection edit
  (`runAiEdit`/`applyAiEdit`, `Content.tsx:446-476`;
  `contentAiEditFlow.ts:23-45`).
- **Media**: inserted by `MediaPanel.insert` as a stable `mediaId` node via
  `editor.chain().insertMedia(...)` (`MediaPanel.tsx:98-108`;
  `ImageBlock.ts:78-97,181-210`).

### 2.6 Layout / CSS facts

- Outer editor grid: `lg:grid-cols-[minmax(0,1fr)_250px]` (`Content.tsx:720`).
- Shell: `min-h-[520px]`, column below `lg`, row at `lg` (`EditorShell.tsx:96`).
- Left rail: `lg:w-[32%] lg:min-w-[240px] lg:max-w-[360px]`, full width below
  `lg` (`EditorSidebar.tsx:23`); only its inner list scrolls
  (`EditorSidebar.tsx:48`).
- ProseMirror: `min-height: 460px`, `padding: 0`, focus outline suppressed in
  page mode (`compositionEditor.css:19-29`).
- Selection is drawn as an outline, never a layout shift
  (`compositionEditor.css:37-45`).
- Theme: Tailwind v4 CSS-first in `apps/web/src/index.css` (`:root` tokens
  `:20-65`, `@theme inline` `:67-109`, prose layer `:117-233`). No
  `tailwind.config.*`. `--cosmos-*` tokens come from the design system, not a
  second theme.
- Responsive usage in the editor is exclusively `lg:`; no `md:`/`sm:` inside the
  shell files.

---

## 3. Component inventory (verified)

All paths relative to `apps/web/src/`.

| Path | Lines | Role | Notes for R1 |
| --- | --- | --- | --- |
| `views/Content.tsx` | 816 | Orchestrates list/viewer/editor; owns all workspace state | 816-line component; the shell extraction happens here |
| `components/content/ContentEditorHeader.tsx` | 122 | Document header | Extract/restructure into `DocumentHeader` |
| `components/content/ContentToolbar.tsx` | 167 | Formatting + AI dropdown | Becomes the contextual toolbar base |
| `components/content/EditorAiBubbleMenu.tsx` | 81 | Selection-scoped AI edit | Keep; becomes part of the fixed AI place |
| `components/content/ContentOutline.tsx` | 50 | Heading outline | Move into intelligence rail |
| `components/content/SeoPanel.tsx` | 157 | Deterministic SEO + meta fields | Move into intelligence rail |
| `components/content/IntelligencePanel.tsx` | 169 | Read-only signals + optional AI | Move into intelligence rail |
| `components/content/MediaPanel.tsx` | 242 | Media library + insert | Contextual media surface |
| `components/content/AgentControls.tsx` | 265 | Starts a new draft job (Writer Engine) | Out of the writing surface; secondary |
| `components/content/WriterPanel.tsx` | 1509 | W6-W10 writer flow, preview-only | Very large; keep unchanged in R1 |
| `components/content/ContentAiPanel.tsx` | 78 | Legacy AI suggestion review | Inline preview/apply |
| `components/content/ContentAiEditPanel.tsx` | 83 | Structured edit review | Inline preview/apply |
| `components/content/KnowledgePanel.tsx` | 296 | Knowledge sources manager | Secondary; currently full-width below |
| `components/content/CosmosPanel.tsx` | 194 | Project editorial/brand config | **Not rendered by the Editor** |
| `components/content/useAutosave.ts` | 97 | Debounced single-flight autosave | Reuse unchanged |
| `components/content/contentAi.ts` | 72 | AI action labels + HTML helpers | Reuse |
| `components/content/contentAiEditFlow.ts` | 45 | Selection range + apply helpers | Reuse |
| `components/content/editorDraft.ts` | 63 | Editor<->canonical bridge + create draft | Reuse |
| `components/content/RichTextEditor.tsx` | 110 | Tiptap wrapper + handle | Reuse; host for contextual toolbar hook |
| `components/content/ImageBlock.ts` | 240 | Custom `image` node (`mediaId`) | Reuse unchanged |
| `components/content/editor/EditorShell.tsx` | 114 | Composition surface (sidebar + toolbar + canvas) | Naming collision; selection trapped here |
| `components/content/editor/EditorMain.tsx` | 29 | Toolbar over canvas | Reuse |
| `components/content/editor/EditorToolbar.tsx` | 116 | Undo/Redo/Delete + save label | Consolidate undo/redo/save |
| `components/content/editor/EditorCanvas.tsx` | 25 | Pointer-up selection wrapper | Pointer-only; needs keyboard path |
| `components/content/editor/EditorSidebar.tsx` | 84 | Elements/Settings rail | Persistent 32% column; candidate to collapse |
| `components/content/editor/ElementBrowser.tsx` | 41 | Element catalog | Controls composition insertion |
| `components/content/editor/ElementSettings.tsx` | 18 | Settings delegate | Reuse |
| `components/content/editor/elementRegistry.ts` | 57 | Element catalog + aliases | Reuse |
| `components/content/editor/settingsRegistry.tsx` | 59 | Selection -> settings renderer | Reuse |
| `components/content/editor/types.ts` | 34 | `EditorSelection`, `SidebarMode`, ... | Extend for active block |
| `components/content/editor/selection.ts` | 46 | PM selection -> `EditorSelection` | Note: `id` is almost always undefined |
| `components/content/editor/insertComposition.ts` | 199 | Composition insert/select/delete | Reuse |
| `components/content/editor/sanitizeDoc.ts` | 82 | Input repair | Reuse unchanged |
| `components/content/editor/extensions.ts` | 33 | Tiptap extension array | Add keyboard extension here |
| `components/content/editor/CompositionNodes.ts` | 139 | Six composition nodes | Reuse unchanged |
| `components/content/editor/CompositionNodeView.tsx` | 55 | React node view + chrome | Reuse |
| `components/content/editor/compositionPresentation.ts` | 61 | Node -> canonical classes | Reuse |
| `components/content/editor/compositionEditor.css` | 88 | Page-mode chrome | Reuse |
| `components/content/editor/index.ts` | 42 | Barrel | Update exports as components move |
| `components/designer/useDesignerRun.ts` | 215 | Durable Designer runs | **Not used by the Editor** (R2/R3) |
| `lib/designSystem.tsx` | 41 | Project design tokens provider | Reuse unchanged |
| `lib/ui.tsx` | 163 | `useAsync`, `Empty`, `StatusPill`, `useJobs` | Reuse |
| `components/canonicalRenderer/CanonicalRenderer.tsx` | ~76 | Live canonical render | Basis for preview |

Tests that pin current shell behaviour and must be respected (or deliberately
updated): `editor/EditorShell.test.tsx` (shell DOM, sidebar modes,
selection, insert Hero/Section, undo/redo), `editor/compositionPageMode.test.tsx`,
`editor/CompositionNodes.test.tsx`, `editor/insertComposition.test.ts`,
`editor/sanitizeDoc.test.ts`, `editor/selection.test.ts`,
`editor/elementRegistry.test.ts`, `content/editorDraft.test.ts`,
`content/contentAiEdit.test.tsx`, `content/WriterPanel.test.tsx`,
`content/AgentControls.test.tsx`, `content/KnowledgePanel.test.tsx`,
`content/CosmosPanel.test.tsx`, `views/Compose.test.tsx`,
`views/Designer.test.tsx`, `lib/designSystem.test.tsx`. There is **no
`Content.test.tsx`**; the Editor view is covered indirectly.

---

## 4. AI surfaces inventory (there is no single place)

| Surface | Where | Endpoint | Applies to document? |
| --- | --- | --- | --- |
| Toolbar AI dropdown | `ContentToolbar.tsx:49-102`, mounted `Content.tsx:723-735` | `POST /projects/:id/content/:contentId/ai` | Yes, via `applyAi` (`Content.tsx:422-437`) |
| Selection bubble menu | `EditorAiBubbleMenu.tsx:26-81`, mounted `RichTextEditor.tsx:107` | `POST .../ai/edit` | Yes, via `applyAiEdit` (`Content.tsx:473-476`) |
| Legacy review panel | `ContentAiPanel.tsx`, `Content.tsx:758-762` | result of the toolbar path | Is the apply UI |
| Structured review panel | `ContentAiEditPanel.tsx`, `Content.tsx:773-782` | result of the bubble path | Is the apply UI |
| Agent Controls (new draft) | `AgentControls.tsx`, `Content.tsx:785-796` | `POST .../draft` | No (creates a new draft) |
| Writer panel | `WriterPanel.tsx`, `Content.tsx:711-718` | writer runs | No (preview-only) |
| Intelligence "Ask AI" | `IntelligencePanel.tsx:111-119`, `Content.tsx:809` | `GET .../intelligence?with_ai=1` | No (read-only) |
| Knowledge context checkbox | `Content.tsx:690-695` | `use_knowledge` flag | Feeds the toolbar path |

R1 must reserve **one** place for AI assistance and stop adding panels, per
contract §12 decision 6. R2 fills that place; R1 only establishes it.

---

## 5. Gap analysis against R1 deliverables

Status: Present / Partial / Duplicated / Missing.

| R1 deliverable (roadmap `:236-251`) | Status | Evidence / gap |
| --- | --- | --- |
| Inventory current Editor components | Done | this document |
| Improve layout and visual hierarchy | Missing | 3 toolbars, 2 rails, 5 stacked panels, full-width knowledge; no hierarchy |
| Document header | Partial | `ContentEditorHeader` mixes title/status/save/actions/slug/wordcount/select |
| Clear save status | Duplicated | `ContentEditorHeader.tsx:75` and `EditorToolbar.tsx:102-113` |
| Undo/redo | Duplicated | `EditorToolbar.tsx:72-91` + `ContentToolbar.tsx:162-163` + Tiptap keymap; no shortcuts |
| Preview | Missing | only the viewer branch's server `content_html` (`Content.tsx:620-628`) |
| Publish/schedule action | Partial | Publish = set status + save (`Content.tsx:353-358`); no real publish pipeline from Editor; schedule only in Calendar |
| Contextual toolbar | Partial | `ContentToolbar` is static formatting; no selection/active-block context; bubble menu is AI-only |
| Selection state | Partial | exists in `EditorShell` only; `id` rarely set (`selection.ts:7-10`); pointer-driven |
| Active block state | Partial | derived on demand; not lifted, not keyboard-operable |
| Fixed place for AI assistance | Missing | six scattered surfaces (§4) |
| Responsive behaviour | Partial/Missing | `lg:`-only; no collapse/drawer; app has no mobile nav |
| Keyboard-first baseline | Missing | no shortcuts except `Keywords.tsx:256`; no Escape/focus management |
| Calm empty/loading/error states | Partial | `Empty` exists; many raw error strings; no toast; banners repeated |

---

## 6. Target shell architecture (implementation brief)

### 6.1 Constraints

- No new route (`docs/editor-native-designer-contract.md` §3, decision 5).
- Do not integrate Designer (R2), do not build the embedded agent (R2), do not
  build image insertion (R3), do not integrate publishing pipeline (R4/R9).
- Reuse `useAutosave`, `RichTextEditor`, `ImageBlock`, the composition editor,
  `contentAiEditFlow`, `lib/ui.tsx`, `lib/designSystem.tsx`, and all
  `components/ui/*` primitives.
- Preserve role gates: `canEdit = rank >= 1`, `canDelete = rank >= 2`
  (`Content.tsx:81,108-110`).
- Preserve the persistence contract: `content_json` stays Tiptap;
  `canonicalFromEditorDocument` guard before persist (`Content.tsx:209`).
- No new UI primitive library; if a tab strip is needed, follow the existing
  segmented-control pattern in `EditorSidebar.tsx:27-46`.

### 6.2 Proposed render tree

A new outer workspace shell (`EditorWorkspace`, settled as D1 in §7) sits in
`Content.tsx` and
replaces the flat stack:

```
<EditorWorkspace>                         // owns layout + selection context
  <DocumentHeader>                        // one header: back, title, status, save,
                                          // primary Preview + Publish/Schedule,
                                          // overflow: History, Delete
  <EditorWorkspaceBody>                   // main grid
    <InsertRail collapsible>              // current EditorSidebar (Elements/Settings)
    <WritingSurface>
      <ContextualToolbar>                 // merged ContentToolbar + EditorToolbar
      <RichTextEditor />                  // unchanged canvas
      <InlineAssistantSlot>               // reserved, empty in R1 (R2 fills it)
      <InlineReview>                      // ContentAiPanel / ContentAiEditPanel in place
    </WritingSurface>
    <IntelligenceRail>                    // segmented: Outline | SEO | Media | Insights
  </EditorWorkspaceBody>
  <KnowledgeSection collapsible />        // demoted, closed by default
</EditorWorkspace>
```

Key hierarchy changes, all justified by contract principle 1.4/1.5 and R1
"professional workspace":

1. **One document header.** Move title + status + save + slug + word count into a
   single header; group primary actions (`Preview`, `Publish`/`Schedule`) and
   move `History`/`Delete` into an overflow. Delete is destructive and stays
   visually separated.
2. **Merge the two canvas toolbars.** One toolbar that holds undo/redo once
   (keyboard-backed), formatting, and the reserved AI entry. Remove the
   duplicate undo/redo from `ContentToolbar` and the save label from
   `EditorToolbar`.
3. **One save indicator.** Keep the header save state (or the toolbar one) but
   not both. `SAVE_LABEL` (`ContentEditorHeader.tsx:15-20`) is the source of
   truth.
4. **Lift selection/active-block state.** Replace `EditorShell`'s private
   `selectedElement` with a shared `EditorSelectionContext` (new, small) that
   provides `{ selection, setSelection }`; `EditorShell` becomes a consumer,
   `Content.tsx` and the contextual toolbar/assistant slot become consumers too.
   This is the prerequisite for R3 location targeting.
5. **Intelligence rail becomes one segmented panel** (Outline | SEO | Media |
   Insights) instead of five stacked cards. This is a layout change, not new
   data; all underlying panels keep their props and data sources.
6. **Knowledge demoted** into a collapsible secondary section (it is a settings
   manager, not part of writing).
7. **Reserved AI place.** `InlineAssistantSlot` is deliberately empty in R1 with
   a small entry affordance; R2 mounts the embedded agent there. This satisfies
   decision 6 without building the agent.

### 6.3 Interaction details

**Document header.** Keep `Input` for title (currently
`ContentEditorHeader.tsx:66-73`). Status/`Publish` semantics stay exactly as they
are in R1: `changeStatus` sets the value and calls `auto.saveNow()`
(`Content.tsx:353-358`). Do **not** invent a publish pipeline. `Schedule` is a
slot/deferred action: in R1 it may link to the existing Calendar view (that is
navigation the app already supports) or remain hidden; it must not fake
scheduling. Settled as D3 (see §7).

**Save status.** Reuse `useAutosave` unchanged. Single display, four states, with
an explicit retry when `failed` (today the retry instruction lives only in the
`Content.tsx:678-682` banner). Keep the banner for failure; do not show two
"Saved" labels.

**Undo/redo.** One toolbar control using
`toolbarActionsFromEditor` (`EditorToolbar.tsx:17-30`) and
`editor.can().undo()/redo()`. Add keyboard: `Mod+Z`, `Mod+Shift+Z` (or
`Mod+Y`). Conflict to resolve: Tiptap already handles these inside the
contenteditable. Strategy: register shortcuts at the workspace level and skip
when the event target is inside `.ProseMirror`, letting Tiptap own in-editor
undo/redo; the toolbar buttons stay authoritative for programmatic undo. This
keeps a single visible concept while avoiding double-undo.

**Preview.** Add an in-workspace preview toggle that renders the live document
via `CanonicalRenderer` using `canonicalFromEditorDocument(doc)`. Handle the
known throwing case (`editorDraft.ts:57-63`) honestly: if the document cannot be
represented canonically, show a calm message and keep the editor visible. Do not
add a route; do not use the stale server `content_html` for preview.

**Contextual toolbar.** Drive it from the lifted selection. At minimum: block
type (paragraph/heading level) and inline marks, plus an insert action and the AI
entry. Keep `ContentToolbar`'s existing command set
(`ContentToolbar.tsx:121-163`) so no editing capability is lost. This is also
where the R3 "insert image here" action will live later, so leave room.

**Selection / active block.** Extend `EditorSelection` only if needed (it already
has `type`, optional `id`, optional `path`, `types.ts:9-13`). Add a stable block
key derived from `path` (nodes today carry no `id`; `selection.ts:7-10` returns
undefined for it). Do not change the document schema in R1. Record that R3 needs
a location contract (contract §11 gap 1/2).

A `path`-derived key is stable only while the document structure **before** the
node is unchanged. It is therefore good enough for R1 context and temporary
selection, but it is **not** a durable identity: two different documents can share
a path, and the key changes as soon as an earlier sibling is inserted/removed.
No R1 code may imply that a path is permanent. A persistent `blockId` (a
schema/contract decision, not a UI decision) stays explicitly open for R3/R4,
when location-aware insertion actually requires it.

**Keyboard-first baseline.** Add a small workspace keymap: `Mod+S` save,
`Mod+Z`/`Mod+Shift+Z` undo/redo, `Escape` to close overlays/menus, and a single
key (proposed `Mod+K`) to focus the reserved AI entry. No hotkey library exists;
implement with a `useEffect` keydown listener in the workspace. Record that
Tiptap owns editing keys.

**Responsive.** Below `lg`, make the insert rail collapsible (default collapsed
or hidden behind a toggle) instead of a full-width 460px-min block
(`EditorSidebar.tsx:23`). The intelligence rail becomes a collapsible section.
Record the pre-existing app-level gap (no mobile project nav,
`App.tsx:474`) as out of R1 scope but known.

**Calm states.** Reuse `Empty` (`lib/ui.tsx:109-111`) and the existing
success/destructive banner tokens. Reduce the number of separate banners by
grouping action errors near the reserved AI area. No toast system will be added
in R1 (it would be a new dependency/surface); keep inline feedback.

### 6.4 File-level plan (indicative)

New (small, focused):

- `components/content/workspace/EditorWorkspace.tsx` — layout + keymap +
  selection provider.
- `components/content/workspace/DocumentHeader.tsx` — extracted/restructured
  from `ContentEditorHeader`.
- `components/content/workspace/ContextualToolbar.tsx` — merged toolbar.
- `components/content/workspace/IntelligenceRail.tsx` — segmented rail wrapper.
- `components/content/workspace/InlineAssistantSlot.tsx` — reserved AI place.
- `components/content/workspace/preview.tsx` (or a `PreviewToggle`) — canonical
  preview.
- `components/content/workspace/EditorSelectionContext.tsx` — shared selection.

Modified:

- `views/Content.tsx` — replace the flat stack with `EditorWorkspace`; keep all
  handlers/state ownership; keep the list and viewer branches.
- `components/content/editor/EditorShell.tsx` — consume the shared selection
  instead of owning it; keep insert behaviour and `data-testid`s unless tests are
  deliberately updated.
- `components/content/editor/EditorToolbar.tsx` / `ContentToolbar.tsx` — remove
  duplicated undo/redo/save.
- `components/content/EditorAiBubbleMenu.tsx` — mount under the reserved AI
  entry (no behaviour change).
- `components/content/editor/index.ts` — export updates.

Unchanged in R1: `useAutosave`, `RichTextEditor`, `ImageBlock`, all composition
editor files, `canonicalRenderer/*`, `lib/designSystem`, all API calls and the
backend.

Deferred: embedded Designer (R2), image insertion (R3), in-editor proposal/apply
redesign (R4), contextual action menu (R5), SEO/intelligence merge (R7), nav
cleanup and standalone Designer removal (R9).

### 6.5 What must not change

- API endpoints and payloads; no backend edits.
- `content_json` Tiptap model and the `canonicalFromEditorDocument` guard.
- Role gates and destructive-action confirmation.
- Autosave semantics (debounce, single-flight, honest failure).
- The review-before-apply rule and the fact that AI writes only via normal
  editor transactions (so Undo works).

---

## 7. Decisions (settled)

These are decided; the implementation brief may treat them as binding.

- **D1 = 1 — naming: new outer shell is `EditorWorkspace`.** `EditorShell` stays
  as the inner composition surface for now. Reason: no unnecessary rename before
  the new hierarchy exists; avoids churn in the barrel and
  `EditorShell.test.tsx`.
- **D2 = 1 — insert rail: collapsible/on-demand.** Elements/Settings appear when
  needed instead of a permanent visual column, keeping the editor calm and
  canvas-first. Reason: the biggest hierarchy lever; the editor should read as a
  document, not as a form with a side panel.
- **D3 = 1 — publish: status-based only.** R1 keeps the existing status-based
  Publish and its `changeStatus` -> `auto.saveNow()` semantics. `Schedule` links
  to the existing Calendar view or stays hidden; no fake scheduling. Reason: R1
  is the editor foundation, not new scheduling functionality.
- **D4 = 1 — preview: `CanonicalRenderer` with an honest fallback.** Reuse the
  existing rendering logic; if a document cannot be represented canonically, show
  a calm message and keep the editor visible. Do not depend on the server-rendered
  viewer for an interactive editor flow. Reason: avoids edit/preview divergence
  and a save round-trip.
- **D5 = 1 — selection key: derived from node `path` for R1.** No document schema
  change in R1. Reason: smallest safe scope.

**D5 nuance (binding).** A node path is stable only while the document structure
before that node is unchanged. Explicitly:

- node `path` is suitable for R1 context and temporary selection;
- node `path` is **not** a durable identity;
- a persistent `blockId` remains a possible R3/R4 decision;
- R1 implementation must not present or treat a path as permanent.

This prevents a temporary mechanism from being mistaken for a foundation.

---

## 8. Test and tooling facts

- Runner: vitest 2.1.9 + jsdom (`apps/web/vitest.config.ts`), RTL, `css: false`.
- Commands: `pnpm --filter @seo/web test`, `pnpm --filter @seo/web typecheck`,
  `pnpm --filter @seo/web build`. Root `pnpm test` runs only `@seo/api`.
- Tests assert class strings and DOM test ids, not computed responsive layout.
- Required new coverage for the implementation phase: header actions/save
  states, single undo/redo + keyboard handling, selection lifted to context,
  preview toggle with the unrepresentable-document fallback, responsive
  collapse, and the reserved AI place rendering. Existing editor shell tests must
  keep passing or be updated deliberately with the same behavioural coverage.

---

## 9. Handoff

Next: write the R1 implementation brief from §6 and §7 decisions, then implement.
Do not start R2 (embedded Designer) or R3 (image insertion) until R1's shell is
in place, so AI cannot be bolted on as another panel.

Recon is complete and the five decisions in §7 are settled (all option 1), so no
further broad inventory or clarification is required before implementation.
