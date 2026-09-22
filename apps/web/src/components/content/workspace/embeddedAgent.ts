/**
 * Embedded Agent entry surface (R2.1).
 *
 * The reusable contract for the first in-editor Agent interaction. It submits a
 * natural-language instruction through the existing durable Designer run
 * endpoint and normalizes the lifecycle into a small, product-language state
 * model. It owns no document state (that comes from `useEditorContext`) and it
 * never mutates content: R2.1 creates the doorway, R3.1 is where the Agent first
 * performs editorial work.
 *
 * Reused infrastructure, discovered in recon:
 *   - POST /projects/:projectId/designer/runs  ({ mode:'intent', instruction,
 *     content_id } for an existing document, or { base_revision } for a
 *     not-yet-persisted one). Returns the durable run and an idempotency hint.
 *   - GET  /projects/:projectId/designer/runs/:runId  (safe lifecycle snapshot).
 *
 * The endpoint does NOT accept a client canonical document or an editor
 * selection, so R2.1 cannot transmit those without inventing a parallel
 * contract; the context is validated locally instead (see the hook). This module
 * is pure: no React, no network.
 */
import {
  IMAGE_SOURCE_POLICY_DEFAULT,
  isImageInsertionInstruction,
  isValidInsertImageOperation,
  resolveVisualDesignIntent,
  type AgentRun,
  type ImageInsertionContext,
  type ImageSourcePolicy,
  type InsertImageOperation,
  type VisualAssetRole,
  type VisualIntent,
} from '@seo/contracts';
import { ApiRequestError } from '../../../lib/api';
import type { EditorSelectionSnapshot } from '../editor/editorContext';

/**
 * Product-language outcome of one Agent interaction. `clarification` is part of
 * the contract for when the backend asks a follow-up question, but no current
 * backend path produces it; the surface still renders it so it needs no redesign
 * once that signal exists.
 */
export type EmbeddedAgentOutcome =
  | { kind: 'working'; message: string }
  | { kind: 'completed'; message: string }
  | { kind: 'insertion'; message: string; operation: InsertImageOperation }
  | { kind: 'generation_required'; message: string; provider: string; model: string }
  | { kind: 'empty'; message: string }
  | { kind: 'clarification'; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string; canRetry: boolean };

/**
 * Local state machine. `working` is not in the original brief's union but is
 * required: a durable run is queued/running before it is terminal, and that must
 * be shown as progress without exposing run ids or state-machine terminology.
 * `clarification` is likewise reserved for a backend follow-up question.
 * `insertion` and `applied` are the R3.1 image path: a reviewable candidate, then
 * the single confirmed insertion into the live editor.
 */
export type EmbeddedAgentState =
  | { status: 'closed' }
  | { status: 'idle'; instruction: string }
  | { status: 'submitting'; instruction: string }
  | { status: 'working'; instruction: string; message: string }
  | { status: 'completed'; instruction: string; message: string }
  | { status: 'insertion'; instruction: string; message: string; operation: InsertImageOperation }
  | {
      status: 'generation';
      instruction: string;
      message: string;
      provider: string;
      model: string;
    }
  | { status: 'applied'; instruction: string; message: string }
  | { status: 'empty'; instruction: string; message: string }
  | { status: 'clarification'; instruction: string; message: string }
  | { status: 'unsupported'; instruction: string; message: string }
  | { status: 'error'; instruction: string; message: string; canRetry: boolean };

/** The initial state before the surface has been opened. */
export const CLOSED_EMBEDDED_AGENT: EmbeddedAgentState = { status: 'closed' };

/** Codes that mean "this capability is not wired yet", not a transient failure. */
const UNAVAILABLE_CODE_RE = /_unavailable$/;

/**
 * Product-language result text. Backend messages are deliberately NOT echoed:
 * they name internal steps (e.g. `writer.freeText`) and orchestration detail the
 * embedded surface must hide. Typed errors are still preserved internally (the
 * classifiers branch on status and code), only the copy is product-facing.
 */
const UNAVAILABLE_MESSAGE = "This action isn't available yet.";
const NO_SUITABLE_IMAGE_MESSAGE = "I couldn't find a suitable image for this section.";
const STALE_IMAGE_CONTEXT_MESSAGE = 'The document changed while I was finding the image. Please run the request again.';
/** R4.2/R4.3: the role could not be anchored to a heading/hero. */
const SECTION_TARGET_UNRESOLVED_MESSAGE =
  "I couldn't find a section heading here. Put the cursor under a section heading and try again.";
const SECTION_IMAGE_PRESENT_MESSAGE = 'This section already has an image. Remove or replace it first, then ask again.';
const HERO_TARGET_UNRESOLVED_MESSAGE =
  "I couldn't find a hero area on this page. Add a hero section or a heading at the top and try again.";
const HERO_IMAGE_PRESENT_MESSAGE = 'This hero already has an image. Remove or replace it first, then ask again.';
/** R4.4: the host region for a background could not be resolved or anchored. */
const BACKGROUND_TARGET_UNRESOLVED_MESSAGE =
  "I couldn't find a section or hero for the background. Put the cursor in a section or the hero and try again.";
const BACKGROUND_IMAGE_PRESENT_MESSAGE = 'This area already has an image. Remove or replace it first, then ask again.';

/** R4.1 product copy for the typed visual-intent outcomes. */
const VISUAL_ROLE_UNSUPPORTED_MESSAGE =
  "That kind of visual isn't supported here yet. I can add an inline image, a section image, a hero image, a background image or an illustration.";
const VISUAL_CLARIFICATION_MESSAGE =
  'What kind of visual do you want here: an inline image, a section image, a hero image, a background image or an illustration?';
const VISUAL_UNSUPPORTED_MESSAGE =
  "I couldn't tell what visual you want here. Try naming it, for example an illustration or a background image.";
const VISUAL_PLACEMENT_UNSUPPORTED_MESSAGE =
  "That placement isn't supported here yet. I can add a contained section image, a full-width hero image or a full-width background.";

/** R4.5A: external image acquisition outcomes. */
const EXTERNAL_SEARCH_UNAVAILABLE_MESSAGE = "I couldn't reach the external image library. Try again in a moment.";
const PROVIDER_NOT_CONFIGURED_MESSAGE =
  'External image search is not set up yet. Add an image to the library or ask an admin to configure a stock-image source.';
const ASSET_PERSISTENCE_FAILED_MESSAGE = "I found an image but couldn't save it to the library. Try again in a moment.";
const EXTERNAL_IMAGE_UNUSABLE_MESSAGE = "I couldn't use that image. Try again.";

/** R4.5B: confirmed AI image generation outcomes. */
const GENERATION_NOT_CONFIGURED_MESSAGE =
  "AI image generation isn't set up yet. Add an image to the library or ask an admin to configure an image provider.";
const GENERATION_FAILED_MESSAGE = "I couldn't generate that image. Try again in a moment.";
const GENERATED_IMAGE_UNUSABLE_MESSAGE = "The generated image couldn't be used. Try again.";

/**
 * R4.5B: product copy for the generation confirmation offer. It states plainly
 * that an AI image is available and that it only runs on an explicit action, so
 * the user is never surprised by a charge or a silent generation.
 */
export const GENERATION_REQUIRED_MESSAGE =
  "I couldn't find a suitable image for this text. I can create one with AI, but it only runs if you confirm it.";

/** Short, non-technical label for the generating provider/model. */
export function imageGenerationLabel(provider: string, model: string): string {
  if (provider === 'openai') return model ? `OpenAI (${model})` : 'OpenAI';
  return model ? `${provider} (${model})` : provider;
}

/** Shown when the user asked for an image but there is no reliable insertion point. */
export const IMAGE_INSERTION_CLARIFICATION_MESSAGE =
  'Where should I place the image? Put the cursor where you want it, or select a paragraph.';

/**
 * R4.5A/R4.5B: the source policy the editor sends with an explicit image request.
 * The call is local-first (the project library is always tried first), external
 * stock search is enabled, and AI generation is *offered* but never automatic:
 * `requireGenerationConfirmation` is true, so the first run can only return a
 * `generation_required` proposal and the confirmed rerun sets
 * `generationConfirmed` to actually generate. The API validates this server-side;
 * the client is never the only guard.
 */
export const EMBEDDED_AGENT_IMAGE_SOURCE_POLICY: ImageSourcePolicy = {
  ...IMAGE_SOURCE_POLICY_DEFAULT,
  allowExternalSearch: true,
  allowGeneration: true,
};

/** Human-readable role labels the inline candidate can show. */
export const VISUAL_ROLE_LABELS: Readonly<Record<VisualAssetRole, string>> = {
  hero: 'Hero visual',
  section: 'Section image',
  inline: 'Inline image',
  background: 'Background visual',
  illustration: 'Illustration',
  icon: 'Icon',
  logo: 'Logo',
  decorative: 'Decorative visual',
  thumbnail: 'Thumbnail',
  avatar: 'Avatar',
};

const VISUAL_INTENT_LABELS: Readonly<Record<VisualIntent, string>> = {
  explain: 'explains',
  reinforce: 'supports the text',
  atmosphere: 'sets the mood',
  emphasis: 'adds emphasis',
  attention: 'guides attention',
  context: 'adds context',
  brand: 'carries the brand',
  decoration: 'decorates',
};

/** Product label for a resolved role, or null when there is none. */
export function visualRoleLabel(role: VisualAssetRole | undefined): string | null {
  return role ? VISUAL_ROLE_LABELS[role] : null;
}

/** Product label for a resolved intent, or null when there is none. */
export function visualIntentLabel(intent: VisualIntent | undefined): string | null {
  return intent ? VISUAL_INTENT_LABELS[intent] : null;
}

/**
 * Product-language message for the R4.1 visual-intent error codes, or null when
 * the code is not one of them. The backend message is not echoed (it names
 * internal roles); the typed code drives the copy.
 */
function visualIntentMessage(code: string | null | undefined): EmbeddedAgentOutcome | null {
  switch (code) {
    case 'visual_role_unsupported':
      return { kind: 'unsupported', message: VISUAL_ROLE_UNSUPPORTED_MESSAGE };
    case 'visual_intent_needs_clarification':
      return { kind: 'clarification', message: VISUAL_CLARIFICATION_MESSAGE };
    case 'visual_intent_unsupported':
      return { kind: 'unsupported', message: VISUAL_UNSUPPORTED_MESSAGE };
    case 'visual_placement_unsupported':
      return { kind: 'unsupported', message: VISUAL_PLACEMENT_UNSUPPORTED_MESSAGE };
    default:
      return null;
  }
}

/**
 * Product-language outcome for the typed image-insertion error codes, or null
 * when the code is not one of them. Keeps the visible copy understandable while
 * the code stays available internally. R4.2 adds the section outcomes, R4.3 the
 * hero outcomes and R4.4 the background outcomes: a missing region is a
 * clarification (the user repositions), an existing image is a neutral note
 * rather than a failure.
 */
function imageInsertionOutcome(code: string | null | undefined): EmbeddedAgentOutcome | null {
  switch (code) {
    case 'image_insertion_no_candidate':
      return { kind: 'empty', message: NO_SUITABLE_IMAGE_MESSAGE };
    case 'stale_editor_context':
      return { kind: 'error', message: STALE_IMAGE_CONTEXT_MESSAGE, canRetry: true };
    case 'image_insertion_requires_saved_document':
    case 'designer_insertion_requires_editor':
      return { kind: 'error', message: 'Save the document before asking for an image.', canRetry: false };
    case 'section_target_unresolved':
      return { kind: 'clarification', message: SECTION_TARGET_UNRESOLVED_MESSAGE };
    case 'section_image_already_present':
      return { kind: 'empty', message: SECTION_IMAGE_PRESENT_MESSAGE };
    case 'hero_target_unresolved':
      return { kind: 'clarification', message: HERO_TARGET_UNRESOLVED_MESSAGE };
    case 'hero_image_already_present':
      return { kind: 'empty', message: HERO_IMAGE_PRESENT_MESSAGE };
    case 'background_target_unresolved':
      return { kind: 'clarification', message: BACKGROUND_TARGET_UNRESOLVED_MESSAGE };
    case 'background_image_already_present':
      return { kind: 'empty', message: BACKGROUND_IMAGE_PRESENT_MESSAGE };
    // R4.5A: external acquisition (stock search). External search being off is a
    // capability note; a reachable-but-failed search or a failed save is retryable.
    case 'provider_not_configured':
      return { kind: 'unsupported', message: PROVIDER_NOT_CONFIGURED_MESSAGE };
    case 'external_search_unavailable':
      return { kind: 'error', message: EXTERNAL_SEARCH_UNAVAILABLE_MESSAGE, canRetry: true };
    case 'asset_persistence_failed':
      return { kind: 'error', message: ASSET_PERSISTENCE_FAILED_MESSAGE, canRetry: true };
    case 'external_image_too_large':
    case 'external_image_untrusted_source':
      return { kind: 'empty', message: EXTERNAL_IMAGE_UNUSABLE_MESSAGE };
    // R4.5B: confirmed AI generation. Not configured is a capability note; a
    // failed generation or an unusable result is recoverable.
    case 'image_generation_not_configured':
      return { kind: 'unsupported', message: GENERATION_NOT_CONFIGURED_MESSAGE };
    case 'image_generation_failed':
      return { kind: 'error', message: GENERATION_FAILED_MESSAGE, canRetry: true };
    case 'generated_image_too_large':
      return { kind: 'empty', message: GENERATED_IMAGE_UNUSABLE_MESSAGE };
    default:
      return null;
  }
}

/**
 * True when an instruction is a visual request this capability can act on: a
 * plain image-insertion request, or an explicit hero/background request ("Maak de
 * hero sterker.", "Gebruik een rustige achtergrond.") that names no image noun.
 * Only those roles are admitted without an image noun: words like "section" appear
 * in ordinary instructions ("Add a section") and must keep routing to the Designer
 * run, not to image insertion.
 */
export function embeddedAgentWantsImageContext(instruction: string): boolean {
  if (isImageInsertionInstruction(instruction)) return true;
  const resolution = resolveVisualDesignIntent(instruction, { nearbyText: '' });
  return resolution.status === 'resolved' && (resolution.intent.role === 'hero' || resolution.intent.role === 'background');
}

export interface EmbeddedAgentSubmissionInput {
  projectId: string;
  /** Null for a brand-new document that has not been persisted yet. */
  contentId: string | null;
  /** Local revision; used as `base_revision` only for a creation (`contentId` null). */
  revision: string | null;
  instruction: string;
  /**
   * The validated R3.1 image-insertion context. Only sent for an existing
   * document; the contract requires `content_id` alongside it.
   */
  imageContext?: ImageInsertionContext | null;
}

export interface EmbeddedAgentSubmission {
  path: string;
  body: Record<string, unknown>;
}

/**
 * Builds the exact request the existing route accepts. Returns null when the
 * instruction is blank or when a creation has no revision to anchor to; the
 * caller must never send a half-formed request. `content_id` and `base_revision`
 * are mutually exclusive by contract, so only one is ever sent.
 */
export function embeddedAgentSubmission(
  input: EmbeddedAgentSubmissionInput,
): EmbeddedAgentSubmission | null {
  const instruction = input.instruction.trim();
  if (!instruction || !input.projectId) return null;
  const path = `/projects/${input.projectId}/designer/runs`;
  if (input.contentId) {
    return {
      path,
      body: {
        mode: 'intent',
        instruction,
        content_id: input.contentId,
        ...(input.imageContext ? { editor_context: input.imageContext } : {}),
      },
    };
  }
  if (!input.revision) return null;
  return { path, body: { mode: 'intent', instruction, base_revision: input.revision } };
}

/** The read path for polling one submitted run. */
export function embeddedAgentRunPath(projectId: string, runId: string): string {
  return `/projects/${projectId}/designer/runs/${runId}`;
}

/**
 * A short, non-technical description of what the Agent will act on. It never
 * claims a precise block target the selection model cannot provide, and it never
 * exposes ids, revisions or run state.
 */
export function embeddedAgentContextHint(selection: EditorSelectionSnapshot): string {
  switch (selection.type) {
    case 'text':
      return 'Working with the selected text.';
    case 'node':
      return 'Working with the selected block.';
    case 'cursor':
      return 'Working at the cursor.';
    default:
      return 'Working with the current document.';
  }
}

function completedMessage(run: AgentRun): string {
  const issues = run.result?.review;
  if (issues && !issues.ok) {
    return 'The Agent prepared a proposal, but its review flagged issues. Your document is unchanged.';
  }
  return 'The Agent prepared a proposal. Your document is unchanged; applying proposals comes in a later step.';
}

/** Product-language description of where a reviewable insertion will land. */
function insertionCandidateMessage(role: VisualAssetRole | undefined): string {
  if (role === 'section') return 'I found a suitable image for this section. Insert it after the heading?';
  if (role === 'hero') return 'I found a suitable hero image. Insert it in the hero?';
  if (role === 'background') return 'I found a suitable background. Insert it in this area?';
  return 'I found a suitable image. Insert it where you asked?';
}

/**
 * Maps a durable run snapshot to a product outcome. Terminal results are
 * grounded in the actual run: a succeeded run produced a proposal (never an
 * applied change), a failure with a `*_unavailable` code is an honest "not
 * available yet", and anything else is a recoverable error whose retryability
 * comes from the backend, not from a guess.
 */
export function embeddedAgentOutcomeFromRun(run: AgentRun): EmbeddedAgentOutcome {
  if (run.status === 'queued' || run.status === 'running') {
    return { kind: 'working', message: 'The Agent is working on your request…' };
  }
  if (run.status === 'succeeded') {
    const acquisition = run.result?.acquisition;
    if (acquisition?.kind === 'generation_required') {
      return {
        kind: 'generation_required',
        message: GENERATION_REQUIRED_MESSAGE,
        provider: acquisition.provider,
        model: acquisition.model,
      };
    }
    const insertion = run.result?.insertion;
    if (isValidInsertImageOperation(insertion)) {
      return {
        kind: 'insertion',
        message: insertionCandidateMessage(insertion.visual?.role),
        operation: insertion,
      };
    }
    return { kind: 'completed', message: completedMessage(run) };
  }
  const error = run.error;
  const insertionOutcome = imageInsertionOutcome(error?.code);
  if (insertionOutcome) return insertionOutcome;
  const visualOutcome = visualIntentMessage(error?.code);
  if (visualOutcome) return visualOutcome;
  if (error && UNAVAILABLE_CODE_RE.test(error.code)) {
    return { kind: 'unsupported', message: UNAVAILABLE_MESSAGE };
  }
  return {
    kind: 'error',
    message: "The Agent couldn't complete that request.",
    canRetry: error?.retryable === true,
  };
}

/**
 * Maps a submission or polling failure to a product outcome. Server messages are
 * not shown (see the note above); the typed error drives the copy and the
 * retryability. Authorization and not-found failures are not retryable.
 */
export function embeddedAgentOutcomeFromError(error: unknown): EmbeddedAgentOutcome {
  if (error instanceof ApiRequestError) {
    const insertionOutcome = imageInsertionOutcome(error.code);
    if (insertionOutcome) return insertionOutcome;
    const visualOutcome = visualIntentMessage(error.code);
    if (visualOutcome) return visualOutcome;
    if (error.status === 401 || error.status === 403) {
      return { kind: 'error', message: "You don't have access to ask the Agent here.", canRetry: false };
    }
    if (error.status === 404) {
      return { kind: 'error', message: 'This document is no longer available.', canRetry: false };
    }
    if (error.status === 501 || error.status === 503 || UNAVAILABLE_CODE_RE.test(error.code)) {
      return { kind: 'unsupported', message: UNAVAILABLE_MESSAGE };
    }
    if (error.status === 429 || error.status >= 500) {
      return { kind: 'error', message: 'The Agent is unavailable right now. Try again in a moment.', canRetry: true };
    }
    return { kind: 'error', message: "The Agent couldn't use that instruction. Try rephrasing it.", canRetry: true };
  }
  return {
    kind: 'error',
    message: 'Could not reach the Agent. Check your connection and try again.',
    canRetry: true,
  };
}
