# Phase 5 Roadmap: Unified Creative Workspace

Status: frozen at the phase level. Each milestone is a rough pointer, not an
implementation brief. Break milestones into small, reviewable slices only after
inspecting the relevant code.

## Phase objective

Transform the current separate Composer, Designer, and Editor experiences into
one project-scoped creative workspace where the user can:

- compose page structure;
- design visual presentation;
- edit content;
- preview the result;
- save and eventually publish;

without leaving the page or switching between competing document states.

The workspace becomes the primary user experience for creating and refining
content.

## High-level roadmap

- R5.1 Workspace architecture and route consolidation
- R5.2 Unified document/session state
- R5.3 Three-mode workspace shell
- R5.4 Composer integration
- R5.5 Designer integration
- R5.6 Editor integration
- R5.7 Preview and responsive experience
- R5.8 Simplified contextual UI
- R5.9 Account and project administration foundation
- R5.10 Usage metering and cost-accounting foundation
- R5.11 End-to-end hardening and UX cleanup

## R5.1 Workspace Architecture and Route Consolidation

Goal: Establish the unified workspace as the canonical destination.

Work:

- Identify current Composer, Designer, and Editor routes.
- Define the new workspace route.
- Decide which existing routes redirect to it.
- Establish the workspace shell.
- Define mode state: `composer`, `designer`, `editor`.
- Preserve project and content identity in the route.
- Avoid introducing a second document model.

Deliverable: A single workspace route can open the current document and switch
between placeholder modes.

Done when: The three existing experiences have a clear home inside one route.

## R5.2 Unified Document and Session State

This is probably the most architecturally important milestone.

Goal: All three modes operate on the same live document context.

Work:

- One canonical document state.
- One revision and dirty-state model.
- One save lifecycle.
- One selection model.
- One undo/redo boundary.
- One autosave mechanism.
- Shared loading and error states.
- Shared project/content context.
- Prevent remounting from discarding unsaved changes.

Explicit non-goal: Do not rewrite the editor or create a new state-management
framework unless the existing architecture genuinely cannot support the unified
model.

Done when switching modes does not:

- reload the document unnecessarily;
- lose selection;
- lose unsaved changes;
- create conflicting save operations;
- instantiate competing document states.

## R5.3 Three-Mode Workspace Shell

Goal: Create the simplified visible structure.

```
+------------------------------------------------------------------+
| Project / Page / Save status                                      |
+------------------------------------------------------------------+
|   COMPOSER             DESIGNER             EDITOR                |
+------------------------------------------------------------------+
|                                                                  |
|                            CANVAS                                |
|                                                                  |
|                                                                  |
+------------------------------------------------------------------+
| Contextual assistant / status / actions                           |
+------------------------------------------------------------------+
```

Work:

- Three prominent mode buttons.
- Active mode styling.
- Shared header.
- Shared canvas area.
- Shared assistant entry point.
- Shared save indicator.
- Mode switching without route navigation.
- Keyboard accessibility.
- Responsive behavior.

Design principle: The buttons are not three applications. They are three ways of
working on the same page.

## R5.4 Composer Integration

Goal: Bring composition into the unified workspace without preserving a separate
Composer application experience.

Composer responsibilities:

- Create page structure.
- Add and arrange sections.
- Define hierarchy.
- Create hero sections.
- Add content blocks.
- Propose structural changes.

Work:

- Mount the existing Composer functionality inside the workspace.
- Adapt Composer output to the shared document context.
- Replace standalone Composer navigation.
- Ensure structural proposals use the existing operation-batch model.
- Add clear apply/review behavior.
- Preserve the distinction between proposal and document mutation.

Done when: A user can compose a page and immediately switch to Designer or
Editor with the same result.

## R5.5 Designer Integration

Goal: Make visual design a mode of the same workspace.

Designer responsibilities:

- Select or generate images.
- Apply visual roles.
- Manage hero, section, and background visuals.
- Suggest visual improvements.
- Handle visual intent and placement.
- Work from current selection and document context.

Work:

- Embed the existing Designer capability.
- Remove separate Designer page assumptions.
- Reuse the same canvas and selection.
- Ensure generated/external image proposals apply through the shared
  EditorContext.
- Display provenance consistently.
- Make Designer actions contextual to the selected block or region.

Done when: The user can compose a section, design its visuals, and edit its
content without leaving the workspace.

## R5.6 Editor Integration

Goal: Make direct editing the default and most stable interaction layer.

Work:

- Embed the existing Editor shell.
- Simplify toolbars.
- Preserve direct text editing.
- Preserve block selection and manipulation.
- Integrate SEO context without overwhelming the canvas.
- Integrate the embedded Agent.
- Ensure Composer and Designer changes appear immediately in the Editor.

Important decision: The Editor should probably be the default mode when opening
an existing document, while Composer and Designer are explicit working modes.
That gives users a stable starting point rather than opening them into an
abstract planning interface.

## R5.7 Preview and Responsive Experience

Goal: Let users see the page as an actual page, not merely as an arrangement of
editor blocks.

Work:

- Preview mode or preview pane.
- Desktop/mobile view.
- Render canonical document consistently.
- Ensure hero, section, image, and layout attributes survive rendering.
- Establish the boundary between editing canvas and page preview.
- Avoid creating a second editable document.

Done when: The user can inspect the resulting experience without wondering
whether they are looking at the editor or the actual page.

## R5.8 Simplified Contextual UI

This should come after the unified shell exists. Otherwise, we will polish three
separate interfaces and then throw half of it away.

Goal: Reduce visible complexity and expose tools when relevant.

Work:

- Remove duplicated navigation.
- Reduce persistent sidebars.
- Contextualize controls based on:
  - active mode;
  - selected block;
  - current task;
  - available capability.
- Collapse advanced controls.
- Standardize empty, loading, error, and success states.
- Keep the main canvas visually dominant.
- Make the assistant entry point consistent.

Possible UI model:

| User intent                     | Primary mode |
| ------------------------------- | ------------ |
| "What should this page contain?"| Composer     |
| "How should this look?"         | Designer     |
| "Change this text"              | Editor       |
| "Show me the final result"      | Preview      |

The user should not need to understand the internal agent architecture.

## R5.9 Account and Project Administration Foundation

Payments are explicitly not the priority, but the account structure should exist
before the application grows further.

Goal: Provide a clean administrative home without building a billing platform.

Account sections:

- Profile
- Account settings
- Projects
- Project members and roles
- Connected integrations
- AI/API credentials
- Usage
- Billing placeholder

Work:

- Account navigation shell.
- Project settings surface.
- Existing project selector integration.
- Role-aware visibility.
- Account-level versus project-level configuration clarity.
- Placeholder for future billing.

Done when a user can understand:

- who they are;
- which projects they own or access;
- where integrations and credentials belong;
- where future usage and billing information will appear.

## R5.10 Usage Metering and Cost-Accounting Foundation

This should happen before payments, but not become a major product distraction.

Goal: Record usage facts consistently now so future billing is based on evidence
rather than archaeology.

First version should measure:

AI:

- provider;
- model;
- operation;
- account;
- project;
- user where relevant;
- input tokens;
- output tokens;
- image generations;
- success/failure;
- timestamps.

Data providers:

- DataForSEO endpoint;
- task count;
- keyword count;
- SERP requests;
- GSC requests.

Jobs:

- job type;
- provider;
- duration;
- outcome;
- retry count.

Publishing and media:

- provider;
- operation;
- asset count;
- publish attempts.

Suggested internal phases:

- R5.10.1 Define usage event vocabulary
- R5.10.2 Add append-only usage event persistence
- R5.10.3 Instrument AI and image generation
- R5.10.4 Instrument DataForSEO and background jobs
- R5.10.5 Add basic account/project usage view

Do not start with:

- subscription plans;
- credit wallets;
- payment processing;
- invoices;
- complicated quotas.

First answer: What did this account or project actually consume?

## R5.11 End-to-End Hardening and UX Cleanup

Goal: Make the unified workspace feel like one finished product rather than three
systems sharing a roof.

Work:

- Remove obsolete routes and components.
- Remove duplicate state providers.
- Remove dead navigation.
- Verify deep links.
- Verify refresh behavior.
- Verify unsaved changes.
- Verify permissions.
- Verify keyboard navigation.
- Verify mobile/responsive behavior.
- Verify all three modes against the same document.
- Verify image generation and operation batches inside the unified workspace.
- Add a short end-to-end smoke test.

Final acceptance test: A user should be able to:

- Open a project.
- Open an existing page or create a new one.
- Compose a hero and sections.
- Add or generate visuals.
- Edit the copy.
- Preview the result.
- Save it.
- Return later and continue.
- Understand where account, integrations, and usage live.

All without navigating between Composer, Designer, and Editor pages.

## Recommended implementation order

Group 1: Architecture

- R5.1 Workspace architecture
- R5.2 Unified document/session state
- R5.3 Workspace shell

Review gate: one route, one state, three modes.

Group 2: Capability integration

- R5.4 Composer
- R5.5 Designer
- R5.6 Editor

Review gate: all three capabilities work on one document.

Group 3: Experience quality

- R5.7 Preview
- R5.8 Contextual UI

Review gate: the product feels simpler than the sum of its parts.

Group 4: Platform foundation

- R5.9 Account/project administration
- R5.10 Usage metering

Review gate: the product has a credible home for identity, configuration, and
future economics.

Group 5: Stabilization

- R5.11 End-to-end hardening

## One important scope rule

During R5, new capabilities should be admitted only if they support one of these
questions:

- Does this help the user compose?
- Does this help the user design?
- Does this help the user edit?
- Does this help the user understand or manage the project?
- Does this make future usage accounting reliable?

If not, it goes into a later phase. Otherwise R5 becomes "everything we forgot
to build," which is a very efficient way to build nothing in particular.
