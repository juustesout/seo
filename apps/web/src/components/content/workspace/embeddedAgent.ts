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
import { type AgentRun } from '@seo/contracts';
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
  | { kind: 'clarification'; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string; canRetry: boolean };

/**
 * Local state machine. `working` is not in the original brief's union but is
 * required: a durable run is queued/running before it is terminal, and that must
 * be shown as progress without exposing run ids or state-machine terminology.
 * `clarification` is likewise reserved for a backend follow-up question.
 */
export type EmbeddedAgentState =
  | { status: 'closed' }
  | { status: 'idle'; instruction: string }
  | { status: 'submitting'; instruction: string }
  | { status: 'working'; instruction: string; message: string }
  | { status: 'completed'; instruction: string; message: string }
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

export interface EmbeddedAgentSubmissionInput {
  projectId: string;
  /** Null for a brand-new document that has not been persisted yet. */
  contentId: string | null;
  /** Local revision; used as `base_revision` only for a creation (`contentId` null). */
  revision: string | null;
  instruction: string;
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
    return { path, body: { mode: 'intent', instruction, content_id: input.contentId } };
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
    return { kind: 'completed', message: completedMessage(run) };
  }
  const error = run.error;
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
