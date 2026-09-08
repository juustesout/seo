/**
 * Writer Agent approval boundary (W3).
 *
 * A proposed plan does not start the writing phase on its own: the graph
 * pauses at the awaitApproval interrupt and only resumes when an explicit,
 * validated decision arrives through resumeWriterRun. This module owns that
 * decision vocabulary. It is deliberately tiny and strict:
 *
 *   - approve: `{ decision: "approve" }`
 *   - reject:  `{ decision: "reject", reason?: string }`
 *
 * The schema is `.strict()` and a discriminated union on `decision`, so
 * anything outside this vocabulary - unknown decisions, extra keys, a reason
 * on an approve, non-string or oversized reasons - is rejected outright. A
 * reason is plain, bounded metadata recorded for humans (for example "goes
 * against our pillar page"); it is never fed back to the AI. Approval can
 * therefore only originate from explicitly validated resume input, never from
 * AI, context, a prompt or any other graph channel.
 *
 * parseWriterApprovalDecision is the single gate both the runtime boundary
 * (which turns a failure into a clear ApiError) and the graph node itself
 * (which degrades an out-of-band resume to a failed run) call, so the two
 * layers can never disagree about what a valid decision is.
 */

import { z } from 'zod';

/** Upper bound on the human rejection reason stored next to a rejection. */
export const WRITER_MAX_APPROVAL_REASON_CHARS = 500;

const approveSchema = z
  .object({
    decision: z.literal('approve'),
  })
  .strict();

/** A reason collapses to absent when it is whitespace; otherwise it must be a
 *  non-empty string within the bound. */
const reasonSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().trim().min(1).max(WRITER_MAX_APPROVAL_REASON_CHARS).optional(),
);

const rejectSchema = z
  .object({
    decision: z.literal('reject'),
    reason: reasonSchema,
  })
  .strict();

/**
 * Validates a resume decision into exactly one of the two allowed shapes.
 * strict() + discriminatedUnion reject extra keys (including a reason on an
 * approve) and any unknown decision value.
 */
export const writerApprovalDecisionSchema = z.discriminatedUnion('decision', [approveSchema, rejectSchema]);

/** An explicit human decision on the proposed plan. */
export type WriterApprovalDecision = z.infer<typeof writerApprovalDecisionSchema>;

/** Result of the shared approval gate. */
export type WriterApprovalParse =
  | { ok: true; decision: WriterApprovalDecision }
  | { ok: false; note: string };

/** True when the value is a syntactically valid approval decision. */
export function isWriterApprovalDecision(value: unknown): value is WriterApprovalDecision {
  return writerApprovalDecisionSchema.safeParse(value).success;
}

/**
 * The single validation gate for approval decisions. Returns a bounded,
 * human-readable note on failure; callers decide how to surface it (an
 * ApiError at the runtime boundary, a degraded failed run inside the graph).
 */
export function parseWriterApprovalDecision(value: unknown): WriterApprovalParse {
  const parsed = writerApprovalDecisionSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, decision: parsed.data };
  }
  const firstIssue = parsed.error.issues[0];
  const where = firstIssue?.path?.length ? ` at "${firstIssue.path.join('.')}"` : '';
  return {
    ok: false,
    note: `Approval decision must be exactly { decision: "approve" } or { decision: "reject", reason?: string }${where}${
      firstIssue?.message ? ` (${firstIssue.message})` : ''
    }.`,
  };
}
