# Embedded Agent Entry Surface (R2.1)

Status: **Done.** This document describes the first in-editor Designer Agent
interaction. It records the interaction contract, the component placement, the
context binding, the reused backend flow, the state model, the error behavior,
the non-goals and the exact handoff to R3.1. It does not restate the R0 product
contract (`docs/editor-native-designer-contract.md`) or the R1.2 context
foundation (`docs/editor-context-foundation.md`).

## 1. Purpose

Give the user a doorway to the Designer Agent from inside the editor, so an
instruction like "Zet hier een passende afbeelding." can be expressed without
selecting a project, choosing a document, opening the standalone Designer page or
reading run details.

R2.1 creates the doorway. It submits an instruction through the existing durable
Designer infrastructure, binds the active editor context automatically, and
reports the outcome in product language. It deliberately performs **no document
mutation**: applying proposals, and the first real capability (image insertion),
belong to R3.1.

## 2. User interaction

Closed (subtle, no floating chatbot button):

- The reserved `InlineAssistantSlot` under the canvas shows an "Ask Agent"
  trigger and a one-line prompt.

Open:

- A compact instruction field, a context hint, Cancel and Send.
- No project selector and no document selector; the surface is always scoped to
  the document currently open in the editor.

Submitting:

- Duplicate submission is disabled; the instruction is retained.
- A compact progress line is shown. The user stays in the editor: no navigation,
  no detached page, no run ids or state-machine terms.

Completion:

- Completed: the Agent prepared a proposal. The copy states the document is
  unchanged and that applying comes later. A succeeded run never claims a
  mutation, because R2.1 applies nothing.
- Unsupported: the requested action is not available yet.
- Error: a concise recoverable message, with Retry only when the backend marks
  the failure retryable (transport failures are retryable).
- Clarification: rendered inline; reserved for a backend follow-up question (see
  §9).

## 3. Component placement

All under `apps/web/src/components/content/workspace/`:

- `EmbeddedAgentEntry.tsx` - the surface; reads the editor context, delegates to
  the hook, manages open/focus.
- `EmbeddedAgentInput.tsx` - the presentational instruction field and actions.
- `EmbeddedAgentStatus.tsx` - the presentational status surface.
- `useEmbeddedAgent.ts` - the local state machine, submission and polling.
- `embeddedAgent.ts` - the pure contract: request shape, run path, context hint,
  outcome classifiers.

Composition:

```text
<InlineAssistantSlot>
  <EmbeddedAgentEntry>
    <EmbeddedAgentInput />
    <EmbeddedAgentStatus />
  </EmbeddedAgentEntry>
</InlineAssistantSlot>
```

The entry is mounted through the reserved `InlineAssistantSlot` inside
`EditorWorkspace`, next to the canvas, so it is one fixed place rather than a new
panel or a floating widget.

## 4. Context binding

`EmbeddedAgentEntry` reads the single editor context through
`useEditorContextSnapshot()` and passes identity, revision, dirty state and
representability to `useEmbeddedAgent`. It duplicates no editor state and reads
the context at submit time.

Fields transmitted through the existing endpoint:

| Field | Source | Notes |
| --- | --- | --- |
| `instruction` | user input | trimmed, non-empty |
| `content_id` | `context.contentId` | edit of an existing document |
| `base_revision` | `context.document.revision` | creation only (`contentId` is null) |

Fields deliberately **not** transmitted, because the reused endpoint does not
accept them: the canonical document and the editor selection. Inventing parallel
field names would violate the "use the exact existing contract" rule, so R2.1
validates that context locally instead and leaves the transmission seam to R3.1
(§10).

Dirty policy: because the endpoint derives its revision from the stored content,
submitting a dirty document would silently plan against stale content. The
surface therefore **blocks** submission while dirty and offers "Save now"
(reusing the existing save action). It never silently sends a stale document.

Other blocks, in plain language: not ready, not canonically representable, Agent
not configured, viewer role.

## 5. API integration

`embeddedAgent.submit` uses the shared `api` client (no raw fetch in
components):

- `POST /projects/:projectId/designer/runs` with
  `{ mode: 'intent', instruction, content_id | base_revision }`
  (202, `{ run, reused }`).
- `GET /projects/:projectId/designer/runs/:runId` while the run is queued or
  running, until it is terminal or the bounded poll budget is exhausted.

This is the existing durable Designer flow (the same one the standalone Designer
uses); no replacement endpoint, route, table, job type or orchestration was
added. Authorization is the existing editor+ rule (`requireRole`). The adapter
normalizes typed errors into product outcomes and never forwards transport detail
or backend step names to the UI.

## 6. State model

`EmbeddedAgentState` (in `embeddedAgent.ts`):

- `closed`, `idle`, `submitting`;
- `working` - a durable run is queued/running; added to the brief's union because
  the run is genuinely asynchronous and must be shown as progress without run
  terminology;
- `completed`, `clarification`, `unsupported`;
- `error` with `canRetry`.

Selection `blockId` is not used here and the state model adds nothing to the
editor context's document/revision/dirty/selection ownership.

## 7. Error behavior

- Blank instruction, missing project, missing document, not-ready and
  unrepresentable documents: submission disabled with an explanatory message.
- Dirty document: blocked with "Save now".
- Validation and server failures: recoverable message, retry as appropriate.
- Authorization/expired session: non-retryable message.
- Network/transport failure: recoverable connection message.
- Backend timeout: bounded polling (60 attempts at the configured interval) ends
  with a recoverable "taking longer than expected" message.
- Duplicate submit: synchronously guarded.
- Unmount / context change / close during a request: every request captures the
  document identity and an epoch; a response whose epoch no longer matches is
  ignored, so a stale response can never be shown against another document.

A failed run with a `*_unavailable` code is reported as "not available yet"
rather than an error, because that is what it means.

## 8. Keyboard and focus

- `Mod+K` opens the embedded Agent and focuses the instruction field (the
  existing reservation in `EditorWorkspace` now opens the surface instead of
  focusing the slot).
- `Escape` closes the Agent while focus is inside it; otherwise it keeps the R1
  preview behavior. The entry also closes on `Escape` from the field.
- `Enter` submits; `Shift+Enter` inserts a newline.
- Send is disabled for blank or whitespace-only instructions.
- Closing returns focus to the "Ask Agent" trigger.
- No second keyboard manager was added; the workspace keymap is still the only
  global listener.

## 9. Explicit non-goals

No image search or insertion; no generic autonomous chat; no new Designer route;
no project or document selector; no second editor state; no detached page or
modal; no persistent block ids; no proposal review/apply workflow; no new
database tables or job infrastructure; no agent-generated document mutations; no
new AI provider integration or orchestration architecture.

Clarification is part of the state model and is rendered by
`EmbeddedAgentStatus`, but no current backend path produces it. It is not faked:
the surface simply needs no redesign once such a signal exists.

## 10. R3.1 handoff

The first real capability ("Zet hier een passende afbeelding.") plugs into these
seams without reopening editor architecture:

- `embeddedAgent.ts` `embeddedAgentSubmission` is the single place the request
  shape is built. When the backend contract accepts a canonical document and a
  selection, R3.1 extends it there instead of at call sites.
- `EditorContextSnapshot` already carries `document.canonical`, `document.revision`
  and `selection` (`type`, `from`, `to`, `nodeType`, transient `nodePath`,
  optional real `blockId`). That is enough to distinguish a whole-document, a
  selected-text, a cursor-position and a block-level instruction. The entry reads
  the same snapshot at render and can capture it at submit time.
- `useEmbeddedAgent`'s outcome handling is where an "apply a validated proposal"
  outcome would be added; today `completed` never touches the document.
- `EditorContextProvider.applyExternalDocument({ canonical, expectedRevision })`
  is the revision-guarded, undoable apply seam and reuses the existing autosave
  path. R3.1 applies a validated proposal through it; R2.1 does not call it.
- A real image insertion still needs a wired capability on the backend. The
  current `visual.apply` is not wired (`visual_design_unavailable`), and
  `collectVisualTargets` only finds existing image blocks, so a text document has
  no target. R3.1 must not fake insertion; it resolves the location from the
  selection context and reports an honest failure when it cannot.

## 11. Tests

Added: `embeddedAgent.test.ts` (request shape, run path, context hint, run and
error outcome mapping incl. unsupported/retryability/no internal copy),
`EmbeddedAgentEntry.test.tsx` (closed trigger, focus, Enter vs Shift+Enter,
duplicate submit, Escape, completed, polling to completion, unsupported,
recoverable error with working retry, dirty block + Save now, not-ready,
stale-response protection, no selector, clarification rendering), and updated
`EditorWorkspace.test.tsx` (Mod+K opens and focuses, Escape closes).

Results: contracts build passes; `@seo/api` typecheck and 1563 tests pass;
`@seo/web` typecheck, 364 tests and production build pass.
