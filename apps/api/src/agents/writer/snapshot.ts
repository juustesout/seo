/**
 * Writer run durable snapshot (W7).
 *
 * What may be persisted about a writer run and how it is re-validated. A run's
 * DB row keeps a *safe snapshot* of the resting WriterRunResult - identity,
 * brief, the article plan, the written sections, the canonical review artifact
 * and the honest notes - and nothing else. Deliberately excluded: the bounded
 * retrieval context (reference data is ephemeral and never needed to serve the
 * run to the UI or to resume it; the LangGraph checkpoint is the authoritative
 * execution state), and by construction no credentials, API keys, prompt text,
 * service handles or LangGraph runtime objects.
 *
 * Reads are fail-closed: persisted JSON is parsed with a strict Zod schema and
 * checked for internal consistency (run binding matches the row, status is a
 * known writer status, written sections are a well-formed ordered prefix,
 * review/reviewStatus agree). Anything malformed, unknown, corrupt or
 * inconsistent surfaces as ApiError 500 `writer_run_state_invalid` and is never
 * offered back to a caller or handed to the graph.
 */

import { z } from 'zod';
import { ApiError } from '../../apiErrors.js';
import type { WriterRunId } from './runtime.js';
import type { WriterRunResult } from './runtime.js';
import type {
  WriterApprovalStatus,
  WriterPlan,
  WriterPlanStatus,
  WriterReview,
  WriterReviewStatus,
  WriterStatus,
  WriterWrittenSection,
} from './state.js';

/** Every field of a resting WriterRunResult except the bounded retrieval
 *  context, which is intentionally not persisted. */
export interface WriterRunSnapshot {
  runId: WriterRunId;
  projectId: string;
  requestId: string;
  topic: string;
  targetKeyword: string | null;
  status: WriterStatus;
  plan: WriterPlan | null;
  planStatus: WriterPlanStatus;
  planNote: string | null;
  approval: WriterApprovalStatus;
  approvalReason: string | null;
  writtenSections: WriterWrittenSection[];
  writeNote: string | null;
  review: WriterReview | null;
  reviewStatus: WriterReviewStatus;
  reviewNote: string | null;
}

const writerRelatedContentSchema = z.object({
  title: z.string().min(1),
  slug: z.string().nullable(),
  reason: z.string(),
});

const writerSectionSchema = z.object({
  heading: z.string().min(1).max(2000),
  keyPoints: z.array(z.string()).max(200),
  suggestedKeywords: z.array(z.string()).max(200),
});

const writerPlanSchema = z.object({
  title: z.string().min(1).max(2000),
  metaDescription: z.string().nullable(),
  introductionPurpose: z.string().max(4000),
  sections: z.array(writerSectionSchema).max(200),
  relatedContent: z.array(writerRelatedContentSchema).max(200).optional(),
});

const writerWrittenSectionSchema = z.object({
  sectionId: z.string().regex(/^section_\d+$/),
  content: z.string().min(1).max(20_000),
});

/** The review artifact is validated for shape only (canonical document + html +
 *  deterministic score present); it is produced by our own W5 review, never by
 *  AI, and its deep content is not re-scored here. */
const writerReviewSchema = z.object({
  contentJson: z.object({ type: z.literal('doc') }).passthrough(),
  contentHtml: z.string().min(1),
  seo: z.object({ score: z.number().finite().nonnegative() }).passthrough(),
});

/** Strict top-level schema for a persisted snapshot. `.strict()` fails closed
 *  on any field we did not intend to persist (context, secrets, internal
 *  handles...). Parsed values are narrowed to the WriterRunSnapshot shape by
 *  the parse helpers below (the schema itself infers plain strings for the
 *  branded runId). */
export const writerRunSnapshotSchema = z
  .object({
    runId: z.string(),
    projectId: z.string(),
    requestId: z.string().min(1).max(200),
    topic: z.string().min(1).max(500),
    targetKeyword: z.string().max(300).nullable(),
    status: z.enum([
      'idle',
      'running',
      'planning',
      'awaiting_approval',
      'approved',
      'writing',
      'review_ready',
      'rejected',
      'completed',
      'failed',
      'cancelled',
    ]),
    plan: writerPlanSchema.nullable(),
    planStatus: z.enum(['none', 'proposed', 'failed']),
    planNote: z.string().nullable(),
    approval: z.enum(['pending', 'approved', 'rejected']),
    approvalReason: z.string().nullable(),
    writtenSections: z.array(writerWrittenSectionSchema).max(200),
    writeNote: z.string().nullable(),
    review: writerReviewSchema.nullable(),
    reviewStatus: z.enum(['pending', 'completed', 'failed']),
    reviewNote: z.string().nullable(),
  })
  .strict();

/** Throws the canonical fail-closed error for a corrupt/inconsistent snapshot. */
export function writerSnapshotInvalid(runId: unknown, detail: string): never {
  throw new ApiError(500, 'writer_run_state_invalid', `Persisted writer run state is invalid: ${detail}.`, {
    runId: typeof runId === 'string' ? runId : undefined,
  });
}

/** Structural + binding consistency of a snapshot. All checks fail closed. */
function assertSnapshotConsistency(snapshot: WriterRunSnapshot, runId: string, projectId: string): void {
  if (snapshot.runId !== runId) {
    writerSnapshotInvalid(runId, 'snapshot runId does not match the row');
  }
  if (snapshot.projectId !== projectId) {
    writerSnapshotInvalid(runId, 'snapshot projectId does not match the row');
  }
  for (let i = 0; i < snapshot.writtenSections.length; i += 1) {
    if (snapshot.writtenSections[i].sectionId !== `section_${i}`) {
      writerSnapshotInvalid(runId, 'written sections are not an ordered prefix of the plan');
    }
  }
  if (snapshot.review !== null && snapshot.reviewStatus !== 'completed') {
    writerSnapshotInvalid(runId, 'a review artifact exists without reviewStatus completed');
  }
  if (snapshot.reviewStatus === 'completed' && snapshot.review === null) {
    writerSnapshotInvalid(runId, 'reviewStatus completed without a review artifact');
  }
  if (
    snapshot.status !== 'failed' &&
    snapshot.plan === null &&
    (snapshot.planStatus === 'proposed' || snapshot.planStatus === 'failed')
  ) {
    writerSnapshotInvalid(runId, 'run has no plan outside a failed state');
  }
}

/** Validates raw persisted JSON (state_json) against the strict schema and the
 *  run binding. Throws writer_run_state_invalid on any mismatch - never returns
 *  a partial or repaired snapshot. */
export function parseWriterRunSnapshot(raw: unknown, bind: { runId: string; projectId: string }): WriterRunSnapshot {
  const parsed = writerRunSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    writerSnapshotInvalid(bind.runId, 'state does not match the writer run snapshot schema');
  }
  const snapshot = parsed.data as WriterRunSnapshot;
  assertSnapshotConsistency(snapshot, bind.runId, bind.projectId);
  return snapshot;
}

/** Builds the safe, validated snapshot for a resting WriterRunResult. The
 *  bounded context channel is intentionally dropped; a serialization failure
 *  here is a programmer error and throws. */
export function snapshotFromResult(result: WriterRunResult): WriterRunSnapshot {
  const parsed = writerRunSnapshotSchema.safeParse({
    runId: result.runId,
    projectId: result.projectId,
    requestId: result.requestId,
    topic: result.topic,
    targetKeyword: result.targetKeyword,
    status: result.status,
    plan: result.plan,
    planStatus: result.planStatus,
    planNote: result.planNote,
    approval: result.approval,
    approvalReason: result.approvalReason,
    writtenSections: result.writtenSections,
    writeNote: result.writeNote,
    review: result.review,
    reviewStatus: result.reviewStatus,
    reviewNote: result.reviewNote,
  });
  if (!parsed.success) {
    throw new Error(`writer result for run ${result.runId} did not serialize to a valid snapshot`);
  }
  return parsed.data as WriterRunSnapshot;
}

/** A validated snapshot turned into an honest failed snapshot, e.g. when a
 *  durable run's thread cannot be resumed after a restart. The previous plan is
 *  kept for inspection; the note explains what happened. */
export function failedSnapshot(snapshot: WriterRunSnapshot, note: string): WriterRunSnapshot {
  const parsed = writerRunSnapshotSchema.safeParse({
    ...snapshot,
    status: 'failed',
    writeNote: note,
    review: null,
    reviewStatus: 'pending',
    reviewNote: null,
  });
  if (!parsed.success) {
    throw new Error(`could not build failed snapshot for run ${snapshot.runId}`);
  }
  return parsed.data as WriterRunSnapshot;
}
