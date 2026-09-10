/**
 * Writer Agent Section Magic request layer (W10.1).
 *
 * Section Magic is a controlled, user-triggered AI transformation of a
 * review_ready run. This module owns ONLY the request/intent layer: the strict
 * action vocabulary, the bounded per-action semantics, the optional user
 * instruction (untrusted prose intent) and the translation of a magic request
 * into the validated W8 revision request the existing revision infrastructure
 * applies. It deliberately does NOT duplicate the graph lifecycle, the durable
 * run model, the AI boundary or the review pipeline - a magic request flows
 * through the exact same `revising -> reviewing -> review_ready` round as a W8
 * revision, carrying its magic intent as request metadata.
 *
 * Security model:
 *   - the action vocabulary is a strict enum with deterministic prompt
 *     semantics; an unknown action or tone is rejected, never mapped to a
 *     generic operation;
 *   - the user instruction is bounded and treated as untrusted prose intent:
 *     it may influence the wording of the selected sections only and can never
 *     control graph transitions, project scope, the section selection, the
 *     approval, publishing, credentials or tools (the prompt builder places it
 *     in a delimited USER INTENT block, see revisionWriter.ts);
 *   - the selected sections are re-validated against the canonical approved
 *     plan (shared validateRevisionSectionIds), so unknown, duplicate or
 *     out-of-run section ids fail closed;
 *   - only the AI-boundary output shape ({ content }) ever changes prose; the
 *     model cannot select sections, change the outline or steer the workflow.
 *
 * The stored revision request keeps a deterministic canonical instruction (the
 * bounded action contract text) plus the magic intent metadata, so a crash
 * mid-round can re-issue the exact magic request after a restart without
 * re-running anything that already persisted.
 */

import { z } from 'zod';
import type { WriterMagicAction, WriterMagicTone } from '@seo/contracts';
import {
  WRITER_MAX_REVISION_INSTRUCTION_CHARS,
  validateRevisionSectionIds,
  parseWriterSessionDecision,
  type RevisionSectionValidation,
  type WriterSessionDecision,
} from './revision.js';
import {
  isWriterResearchSessionDecision,
  writerResearchSessionSchema,
  type WriterResearchSessionDecision,
} from './evidence.js';
import {
  isWriterIntelligenceSessionDecision,
  writerIntelligenceSessionSchema,
  type WriterIntelligenceSessionDecision,
} from './intelligence.js';
import type { WriterPlan, WriterRevisionRequest } from './state.js';

/** Canonical Section Magic action vocabulary (W10.1). */
export const WRITER_MAGIC_ACTIONS = [
  'improve',
  'expand',
  'shorten',
  'clarify',
  'change_tone',
  'add_examples',
  'improve_seo',
  'custom',
] as const satisfies readonly WriterMagicAction[];

/** Bounded tone choices for the `change_tone` action. */
export const WRITER_MAGIC_TONES = [
  'professional',
  'friendly',
  'authoritative',
  'conversational',
  'formal',
  'persuasive',
  'practical',
  'casual',
] as const satisfies readonly WriterMagicTone[];

/** Upper bound on a magic user instruction (mirrors the W8 revision bound). */
export const WRITER_MAGIC_MAX_USER_INTENT_CHARS = WRITER_MAX_REVISION_INSTRUCTION_CHARS;

const magicActionSchema = z.enum(WRITER_MAGIC_ACTIONS);
const magicToneSchema = z.enum(WRITER_MAGIC_TONES);

/** Durable magic intent carried on a revision request: which deterministic
 *  action was asked for, plus the optional bounded user prose and - for
 *  `change_tone` - the validated tone. Never anything that could steer the
 *  workflow. Strict and bounded so the persisted snapshot keeps exactly what a
 *  crash mid-round needs to re-issue the exact magic. */
export const writerMagicIntentSchema = z
  .object({
    action: magicActionSchema,
    tone: magicToneSchema.optional(),
    userIntent: z.string().trim().min(1).max(WRITER_MAGIC_MAX_USER_INTENT_CHARS).optional(),
  })
  .strict();

export type WriterMagicIntent = z.infer<typeof writerMagicIntentSchema>;

/** A validated, plan-independent magic request (section ids not yet checked
 *  against the plan). */
export interface WriterMagicRequestInput {
  sectionIds: string[];
  magic: WriterMagicIntent;
}

const magicSectionSchema = z.array(z.string().regex(/^section_\d+$/)).min(1).max(12);

/** Strict magic request schema. Discriminated by `action` so each action only
 *  accepts the fields it may carry (change_tone requires a validated tone and
 *  forbids an instruction; custom requires the user instruction; the rest take
 *  an optional instruction and never a tone). Unknown keys and actions are
 *  rejected outright. */
export const writerMagicRequestSchema = z
  .object({
    sectionIds: magicSectionSchema,
    action: magicActionSchema,
    instruction: z.string().trim().min(1).max(WRITER_MAGIC_MAX_USER_INTENT_CHARS).optional(),
    tone: magicToneSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'change_tone') {
      if (!value.tone) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tone'],
          message: 'change_tone requires a tone from the validated tone vocabulary.',
        });
      }
      if (value.instruction !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['instruction'],
          message: 'change_tone takes a tone, not a free-text instruction.',
        });
      }
    }
    if (value.action === 'custom' && !value.instruction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instruction'],
        message: 'The custom action requires a bounded instruction describing what to change.',
      });
    }
    if (value.action !== 'change_tone' && value.tone !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tone'],
        message: `tone is only valid for the change_tone action, not ${value.action}.`,
      });
    }
  });

export type WriterMagicParse =
  | { ok: true; request: WriterMagicRequestInput }
  | { ok: false; note: string };

/** The single validation gate for a Section Magic request body. Returns a
 *  bounded, human-readable note on failure. Section ids are shape-validated
 *  here; existence against the approved plan is checked separately against the
 *  run's plan (buildMagicRevisionRequest), because the magic layer never knows
 *  a plan on its own. */
export function parseWriterMagicRequest(value: unknown): WriterMagicParse {
  const parsed = writerMagicRequestSchema.safeParse(value);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const where = firstIssue?.path?.length ? ` at "${firstIssue.path.join('.')}"` : '';
    return {
      ok: false,
      note: `A magic request must be { sectionIds: [...], action: "<one of ${WRITER_MAGIC_ACTIONS.join('|')}>" } with an optional bounded instruction (and a tone for change_tone)${where}${
        firstIssue?.message ? ` (${firstIssue.message})` : ''
      }.`,
    };
  }
  const data = parsed.data;
  const magic: WriterMagicIntent = { action: data.action };
  if (data.tone !== undefined) magic.tone = data.tone;
  if (data.instruction !== undefined) magic.userIntent = data.instruction.trim();
  return { ok: true, request: { sectionIds: data.sectionIds, magic } };
}

/** True when the value is a syntactically valid magic request body. */
export function isWriterMagicRequest(value: unknown): value is WriterMagicRequestInput {
  return writerMagicRequestSchema.safeParse(value).success;
}

/** Human label of a magic action (the UI and prompts share this vocabulary). */
export function magicActionLabel(action: WriterMagicAction): string {
  switch (action) {
    case 'improve':
      return 'Improve';
    case 'expand':
      return 'Expand';
    case 'shorten':
      return 'Shorten';
    case 'clarify':
      return 'Clarify';
    case 'change_tone':
      return 'Change tone';
    case 'add_examples':
      return 'Add examples';
    case 'improve_seo':
      return 'Improve SEO';
    case 'custom':
      return 'Custom';
  }
}

/** Human label of a validated tone value. */
export function magicToneLabel(tone: WriterMagicTone): string {
  return tone.replace('_', ' ');
}

/** Deterministic, bounded instruction recorded on the stored revision request.
 *  For every action this is the canonical action contract (so the durable
 *  request stays meaningful on its own); the user's prose refinement never
 *  becomes the authoritative instruction - it travels as the delimited
 *  `magic.userIntent` block. */
export function magicRequestInstruction(magic: WriterMagicIntent): string {
  switch (magic.action) {
    case 'improve':
      return 'Improve the clarity, flow and readability of this section while preserving its intended meaning and on-topic focus.';
    case 'expand':
      return 'Add useful, on-topic detail that deepens this section without inventing facts.';
    case 'shorten':
      return 'Make this section more concise while preserving its important information and intended meaning.';
    case 'clarify':
      return 'Improve comprehensibility: explain unclear concepts plainly and keep the section coherent.';
    case 'change_tone':
      return `Make this section sound more ${magic.tone ? magicToneLabel(magic.tone) : 'professional'} while keeping its meaning.`;
    case 'add_examples':
      return 'Add illustrative examples where appropriate; never present them as fabricated factual evidence.';
    case 'improve_seo':
      return 'Improve relevance and readability for the approved topic and keyword without keyword-stuffing.';
    case 'custom':
      return 'Apply the user prose request to this section; it may change wording only.';
  }
}

/** Builds the validated W8 revision request for a magic request against the
 *  run's approved plan. This is the single translation point: it re-validates
 *  the section selection against the plan (unknown/duplicate/out-of-run ids
 *  fail closed), orders the ids to match the plan and attaches the canonical
 *  instruction plus the magic intent metadata. */
export function buildMagicRevisionRequest(
  plan: WriterPlan,
  input: WriterMagicRequestInput,
): { ok: true; request: WriterRevisionRequest } | { ok: false; note: string } {
  const validation: RevisionSectionValidation = validateRevisionSectionIds(plan, input.sectionIds);
  if (!validation.ok) return { ok: false, note: validation.note };
  return {
    ok: true,
    request: {
      sectionIds: validation.sectionIds,
      instruction: magicRequestInstruction(input.magic),
      magic: {
        action: input.magic.action,
        ...(input.magic.tone !== undefined ? { tone: input.magic.tone } : {}),
        ...(input.magic.userIntent !== undefined ? { userIntent: input.magic.userIntent } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Review-session resume vocabulary for magic (shared with accept/revise)
// ---------------------------------------------------------------------------
//
// A review_ready run resumes with a validated review-session value. W8 owns
// accept/revise (revision.ts); W10.1 adds one more, strictly-validated value -
// `{ action: "magic", sectionIds, magicAction, instruction?, tone? }` - which
// the session gate translates through buildMagicRevisionRequest into the same
// revising round. No new lifecycle state exists: magic flows through the W8
// `revising -> reviewing -> review_ready` path with request metadata only.

const magicSessionSchema = z
  .object({
    action: z.literal('magic'),
    sectionIds: magicSectionSchema,
    magicAction: magicActionSchema,
    instruction: z.string().trim().min(1).max(WRITER_MAGIC_MAX_USER_INTENT_CHARS).optional(),
    tone: magicToneSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.magicAction === 'change_tone') {
      if (!value.tone) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tone'],
          message: 'change_tone requires a tone from the validated tone vocabulary.',
        });
      }
      if (value.instruction !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['instruction'],
          message: 'change_tone takes a tone, not a free-text instruction.',
        });
      }
    }
    if (value.magicAction === 'custom' && !value.instruction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instruction'],
        message: 'The custom magic action requires a bounded instruction.',
      });
    }
    if (value.magicAction !== 'change_tone' && value.tone !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tone'],
        message: `tone is only valid for change_tone, not ${value.magicAction}.`,
      });
    }
  });

export type WriterMagicSessionDecision = z.infer<typeof magicSessionSchema>;

/** A valid review-session resume value: W8 accept/revise, W10.1 magic, the
 *  W10.2 research gather (`{ action: "research" }`, see evidence.ts) or the
 *  W10.3 intelligence gather (`{ action: "intelligence" }`, see
 *  intelligence.ts). */
export type WriterReviewSessionResume =
  | WriterSessionDecision
  | WriterMagicSessionDecision
  | WriterResearchSessionDecision
  | WriterIntelligenceSessionDecision;

export type WriterSessionResumeParse =
  | { ok: true; resume: WriterReviewSessionResume }
  | { ok: false; note: string };

/** True when the value is a valid magic session resume. */
export function isWriterMagicSessionDecision(value: unknown): value is WriterMagicSessionDecision {
  return magicSessionSchema.safeParse(value).success;
}

/** The single validation gate for review-session resumes (W8 accept/revise,
 *  W10.1 magic and W10.2 research). Both the graph node and the resume
 *  boundaries call this so the layers can never disagree about what a valid
 *  session resume is. */
export function parseReviewSessionResume(value: unknown): WriterSessionResumeParse {
  const session = parseWriterSessionDecision(value);
  if (session.ok) return { ok: true, resume: session.decision };
  const magic = magicSessionSchema.safeParse(value);
  if (magic.success) return { ok: true, resume: magic.data };
  if (isWriterResearchSessionDecision(value)) {
    return { ok: true, resume: writerResearchSessionSchema.parse(value) };
  }
  if (isWriterIntelligenceSessionDecision(value)) {
    return { ok: true, resume: writerIntelligenceSessionSchema.parse(value) };
  }
  return { ok: false, note: session.note };
}

/** Converts a validated magic session resume into the plan-independent magic
 *  request the graph feeds to buildMagicRevisionRequest. */
export function magicSessionToRequest(resume: WriterMagicSessionDecision): WriterMagicRequestInput {
  const magic: WriterMagicIntent = { action: resume.magicAction };
  if (resume.tone !== undefined) magic.tone = resume.tone;
  if (resume.instruction !== undefined) magic.userIntent = resume.instruction;
  return { sectionIds: resume.sectionIds, magic };
}

/** Builds the W8 session resume that re-issues a persisted magic revision
 *  request after a restart (see WriterRunService recovery). */
export function magicResumeFromRequest(request: WriterRevisionRequest): WriterMagicSessionDecision {
  const magic = request.magic as WriterMagicIntent;
  return {
    action: 'magic',
    sectionIds: request.sectionIds,
    magicAction: magic.action,
    ...(magic.tone !== undefined ? { tone: magic.tone } : {}),
    ...(magic.userIntent !== undefined ? { instruction: magic.userIntent } : {}),
  };
}
