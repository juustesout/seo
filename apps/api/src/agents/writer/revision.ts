/**
 * Writer Agent review-session boundary (W8).
 *
 * A review_ready run rests on the review-session interrupt with its canonical
 * W5 artifact available - it is NOT terminal. Only an explicit, validated
 * session resume moves it forward again, and this module owns that resume
 * vocabulary. It is deliberately separate from the W3 approval vocabulary:
 * approve/reject decide on the PROPOSED PLAN (awaiting_approval), while the
 * review session decides on the REVIEW-READY RESULT and is the only gate that
 * can complete or revise a run:
 *
 *   - accept: `{ action: "accept" }` - the human accepts the review-ready
 *     result; the run moves to `completed` (terminal). This is the W8
 *     explicit save-finalization; nothing ever reaches `completed`
 *     automatically.
 *   - revise: `{ action: "revise", sectionIds: [...], instruction: "..." }` -
 *     the AI rewrites exactly the requested sections and the deterministic
 *     re-review produces a fresh review_ready artifact.
 *
 * Both schemas are `.strict()` and discriminated on `action`, so anything
 * outside this vocabulary - unknown actions, extra keys, a reason on an
 * accept, non-array or out-of-bound sectionIds, missing/oversized
 * instructions - is rejected outright. A revision can therefore only
 * originate from explicitly validated resume input, never from AI, context, a
 * prompt or any other graph channel.
 *
 * Sections are addressed by their stable `section_<index>` identity (derived
 * from the canonical approved plan); the boundary re-validates that every id
 * exists in that plan, that there are no duplicates and that the request is
 * ordered to match the plan, so the revision never depends on UI order,
 * heading text or an AI-generated identifier.
 *
 * parseWriterSessionDecision + validateRevisionSectionIds are the single gates
 * both the runtime/durable boundary (which turns a failure into a clear
 * ApiError) and the graph node itself (which degrades an out-of-band resume to
 * a failed run) call, so the layers can never disagree about what a valid
 * session resume is.
 */

import { z } from 'zod';
import type { WriterPlan } from './state.js';

/** Upper bound on the human revision instruction stored next to a round. */
export const WRITER_MAX_REVISION_INSTRUCTION_CHARS = 2_000;

const acceptSessionSchema = z
  .object({
    action: z.literal('accept'),
  })
  .strict();

const reviseSessionSchema = z
  .object({
    action: z.literal('revise'),
    /** Stable section identities to rewrite (re-validated against the plan). */
    sectionIds: z.array(z.string().regex(/^section_\d+$/)).min(1).max(12),
    instruction: z.string().trim().min(1).max(WRITER_MAX_REVISION_INSTRUCTION_CHARS),
  })
  .strict();

/** A valid review-session resume: accept (-> completed) or revise (rewrite the
 *  requested sections and re-review). */
export const writerSessionDecisionSchema = z.discriminatedUnion('action', [acceptSessionSchema, reviseSessionSchema]);

export type WriterSessionDecision = z.infer<typeof writerSessionDecisionSchema>;

/** Result of the shared review-session gate. */
export type WriterSessionParse =
  | { ok: true; decision: WriterSessionDecision }
  | { ok: false; note: string };

/** True when the value is a syntactically valid session decision. */
export function isWriterSessionDecision(value: unknown): value is WriterSessionDecision {
  return writerSessionDecisionSchema.safeParse(value).success;
}

/**
 * The single validation gate for review-session resumes. Returns a bounded,
 * human-readable note on failure; callers decide how to surface it (an
 * ApiError at the runtime/durable boundary, a degraded failed run inside the
 * graph).
 */
export function parseWriterSessionDecision(value: unknown): WriterSessionParse {
  const parsed = writerSessionDecisionSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, decision: parsed.data };
  }
  const firstIssue = parsed.error.issues[0];
  const where = firstIssue?.path?.length ? ` at "${firstIssue.path.join('.')}"` : '';
  return {
    ok: false,
    note: `A review session must be resumed with { action: "accept" } or { action: "revise", sectionIds: [...], instruction: "..." }${where}${
      firstIssue?.message ? ` (${firstIssue.message})` : ''
    }.`,
  };
}

/** Result of validating a revision's section selection against the plan. */
export type RevisionSectionValidation =
  | { ok: true; sectionIds: string[] }
  | { ok: false; note: string };

/**
 * Re-validates the requested section ids against the canonical approved plan:
 * every id must address an existing plan section, each at most once, and the
 * result is ordered ascending to match the plan so the AI rewrites in plan
 * order regardless of request order. The plan itself is never modified.
 */
export function validateRevisionSectionIds(plan: WriterPlan, sectionIds: string[]): RevisionSectionValidation {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const sectionId of sectionIds) {
    const index = Number(/^section_(\d+)$/.exec(sectionId)?.[1]);
    if (!Number.isInteger(index) || index < 0 || index >= plan.sections.length) {
      return {
        ok: false,
        note: `Section ${sectionId} is not part of the approved plan (${plan.sections.length} sections).`,
      };
    }
    if (seen.has(index)) {
      return { ok: false, note: `Section ${sectionId} was requested more than once.` };
    }
    seen.add(index);
    normalized.push(index);
  }
  normalized.sort((a, b) => a - b);
  return { ok: true, sectionIds: normalized.map((index) => `section_${index}`) };
}
