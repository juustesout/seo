/**
 * Writer run durable snapshot (W7).
 *
 * What may be persisted about a writer run and how it is re-validated. A run's
 * DB row keeps a *safe snapshot* of the resting WriterRunResult - identity,
 * brief, the article plan, the written sections, the canonical review artifact,
 * the honest notes and the W10.2 research evidence the human gathered (evidence
 * IS persisted: after a restart it must stay clear which research context was
 * available, so later revision/magic rounds never fabricate it) - and nothing
 * else. Deliberately excluded: the bounded W1 retrieval context (that reference
 * data is ephemeral and never needed to serve the run to the UI or to resume
 * it; the LangGraph checkpoint is the authoritative execution state), and by
 * construction no credentials, API keys, prompt text, service handles or
 * LangGraph runtime objects.
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
import {
  WRITER_AGENT_ACTIONS,
  WRITER_AGENT_GOALS,
  WRITER_AGENT_MAX_INSTRUCTION_CHARS,
  WRITER_AGENT_MAX_NOTE_CHARS,
  WRITER_AGENT_MAX_SECTIONS,
  WRITER_AGENT_MAX_STEP_SUMMARY_CHARS,
  WRITER_AGENT_MAX_STEPS,
  WRITER_AGENT_MAX_STEPS_STORED,
  WRITER_AGENT_MIN_STEPS,
  WRITER_AGENT_STATUSES,
  WRITER_AGENT_STEP_STATUSES,
  type WriterAgentState,
} from './agent.js';
import type { WriterEvidence, WriterEvidenceSource, WriterEvidenceStatus } from './evidence.js';
import {
  WRITER_MAX_EVIDENCE_ITEM_TEXT_CHARS,
  WRITER_MAX_EVIDENCE_ITEMS,
  WRITER_MAX_EVIDENCE_METADATA_STR_CHARS,
  WRITER_MAX_EVIDENCE_NOTE_CHARS,
  WRITER_MAX_EVIDENCE_SOURCE_ITEMS,
  WRITER_MAX_EVIDENCE_SOURCES,
  WRITER_MAX_EVIDENCE_TITLE_CHARS,
} from './evidence.js';
import type { WriterIntelligence } from './intelligence.js';
import {
  WRITER_MAX_INTELLIGENCE_EVIDENCE_ID_CHARS,
  WRITER_MAX_INTELLIGENCE_EVIDENCE_IDS,
  WRITER_MAX_INTELLIGENCE_FINDINGS,
  WRITER_MAX_INTELLIGENCE_NOTE_CHARS,
  WRITER_MAX_INTELLIGENCE_SOURCE_FINDINGS,
  WRITER_MAX_INTELLIGENCE_SOURCES,
  WRITER_MAX_INTELLIGENCE_SUMMARY_CHARS,
} from './intelligence.js';
import { writerMagicIntentSchema } from './magic.js';
import type { WriterRunId } from './runtime.js';
import type { WriterRunResult } from './runtime.js';
import type {
  WriterApprovalStatus,
  WriterPlan,
  WriterPlanStatus,
  WriterReview,
  WriterReviewStatus,
  WriterRevisionRequest,
  WriterRevisionStatus,
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
  revisionStatus: WriterRevisionStatus;
  revisionCount: number;
  lastRevisionAt: string | null;
  revisionNote: string | null;
  /** Validated revision request of a committed-but-unfinished revise round; set
   *  on the row while it is `revising` so a crash before the thread resume can
   *  re-issue the exact request (see durable.ts). Null otherwise. */
  revisionRequest: WriterRevisionRequest | null;
  /** W10.2 research context the human explicitly gathered for this run, or
   *  null until a research operation has run. Persisted so a restart keeps it
   *  clear which evidence was available. */
  evidence: WriterEvidence | null;
  /** W10.3 intelligence snapshot the human explicitly gathered for this run, or
   *  null until an intelligence operation has run. Persisted so a restart keeps
   *  it clear which combined signals were available. */
  intelligence: WriterIntelligence | null;
  /** W10.4 agent progress record, or null until an agent run is started.
   *  Persisted so an in-flight agent survives a restart and its consumed steps
   *  are never re-run. */
  agent: WriterAgentState | null;
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

const writerRevisionRequestSchema = z
  .object({
    sectionIds: z.array(z.string().regex(/^section_\d+$/)).min(1).max(200),
    instruction: z.string().min(1).max(2_000),
    /** W10.1 Section Magic intent of a magic round; absent for a plain W8
     *  revise so a crash re-issues the exact request (action/tone/user intent)
     *  after a restart. */
    magic: writerMagicIntentSchema.optional(),
  })
  .strict();

const writerEvidenceItemSchema = z
  .object({
    id: z.string().min(1).max(200),
    source: z.enum(['knowledge', 'existing_content', 'search', 'intelligence']),
    title: z.string().max(WRITER_MAX_EVIDENCE_TITLE_CHARS).nullable(),
    text: z.string().max(WRITER_MAX_EVIDENCE_ITEM_TEXT_CHARS),
    url: z.string().nullable(),
    retrievedAt: z.string().nullable(),
    trust: z.literal('untrusted'),
    metadata: z
      .record(
        z.string().min(1).max(120),
        z.union([
          z.string().max(WRITER_MAX_EVIDENCE_METADATA_STR_CHARS),
          z.number().finite(),
          z.boolean(),
          z.null(),
        ]),
      )
      .optional(),
  })
  .strict();

const writerEvidenceSourceSchema = z
  .object({
    source: z.enum(['knowledge', 'existing_content', 'search', 'intelligence']),
    status: z.enum(['available', 'empty', 'not_configured', 'unavailable']),
    note: z.string().max(WRITER_MAX_EVIDENCE_NOTE_CHARS).nullable(),
    items: z.array(writerEvidenceItemSchema).max(WRITER_MAX_EVIDENCE_SOURCE_ITEMS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'not_configured' && value.items.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'A not_configured source cannot carry evidence items.',
      });
    }
  });

/** Strict schema for the persisted W10.2 evidence artifact. `.strict()` fails
 *  closed on anything we did not intend to persist (raw provider responses,
 *  credentials, tokens, internals...). Total item count is re-capped here so a
 *  corrupt snapshot that violates the writer evidence bounds fails closed. */
export const writerEvidenceSchema = z
  .object({
    gatheredAt: z.string().min(1).max(100).nullable(),
    sources: z.array(writerEvidenceSourceSchema).max(WRITER_MAX_EVIDENCE_SOURCES),
  })
  .strict()
  .superRefine((value, ctx) => {
    const totalItems = value.sources.reduce((sum, source) => sum + source.items.length, 0);
    if (totalItems > WRITER_MAX_EVIDENCE_ITEMS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources'],
        message: 'Evidence item count exceeds the writer evidence bound.',
      });
    }
  });

const writerIntelligenceFindingSchema = z
  .object({
    id: z.string().min(1).max(120),
    type: z.enum(['keyword', 'opportunity', 'overlap', 'knowledge', 'content']),
    summary: z.string().min(1).max(WRITER_MAX_INTELLIGENCE_SUMMARY_CHARS),
    evidenceIds: z
      .array(z.string().min(1).max(WRITER_MAX_INTELLIGENCE_EVIDENCE_ID_CHARS))
      .max(WRITER_MAX_INTELLIGENCE_EVIDENCE_IDS),
    trust: z.literal('untrusted'),
  })
  .strict();

const writerIntelligenceSourceSchema = z
  .object({
    source: z.enum(['knowledge', 'existing_content', 'dataforseo', 'gsc', 'content_intelligence']),
    status: z.enum(['available', 'empty', 'not_configured', 'unavailable']),
    note: z.string().max(WRITER_MAX_INTELLIGENCE_NOTE_CHARS).nullable(),
    findingCount: z.number().int().nonnegative().max(WRITER_MAX_INTELLIGENCE_SOURCE_FINDINGS),
  })
  .strict();

/** Strict schema for the persisted W10.3 intelligence snapshot. `.strict()`
 *  fails closed on anything we did not intend to persist (raw provider
 *  responses, credentials, tokens, internals...). Counts and the total finding
 *  cap are re-validated here so a corrupt snapshot fails closed. */
export const writerIntelligenceSchema = z
  .object({
    gatheredAt: z.string().min(1).max(100).nullable(),
    status: z.enum(['available', 'partial', 'empty', 'not_configured', 'unavailable']),
    findings: z.array(writerIntelligenceFindingSchema).max(WRITER_MAX_INTELLIGENCE_FINDINGS),
    sources: z.array(writerIntelligenceSourceSchema).max(WRITER_MAX_INTELLIGENCE_SOURCES),
    note: z.string().max(WRITER_MAX_INTELLIGENCE_NOTE_CHARS).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const declared = value.sources.reduce((sum, source) => sum + source.findingCount, 0);
    if (declared !== value.findings.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['findings'],
        message: 'Intelligence source finding counts do not match the findings array.',
      });
    }
    for (const source of value.sources) {
      if (source.status === 'not_configured' && source.findingCount > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources'],
          message: 'A not_configured intelligence source cannot carry findings.',
        });
      }
    }
  });

const writerAgentStepSchema = z
  .object({
    index: z.number().int().nonnegative(),
    action: z.enum(WRITER_AGENT_ACTIONS),
    status: z.enum(WRITER_AGENT_STEP_STATUSES),
    summary: z.string().max(WRITER_AGENT_MAX_STEP_SUMMARY_CHARS).nullable(),
  })
  .strict();

/** Strict schema for the persisted W10.4 agent progress record. `.strict()`
 *  fails closed on anything we did not intend to persist (prompts, reasoning,
 *  tools, credentials...). Step indices, counts and the step cap are re-checked
 *  so a corrupt snapshot that does not match its own counters fails closed. */
export const writerAgentSchema = z
  .object({
    status: z.enum(WRITER_AGENT_STATUSES),
    goal: z.enum(WRITER_AGENT_GOALS),
    instruction: z.string().max(WRITER_AGENT_MAX_INSTRUCTION_CHARS).nullable(),
    maxSteps: z.number().int().min(WRITER_AGENT_MIN_STEPS).max(WRITER_AGENT_MAX_STEPS),
    stepCount: z.number().int().nonnegative(),
    steps: z.array(writerAgentStepSchema).max(WRITER_AGENT_MAX_STEPS_STORED),
    actionCounts: z.record(z.enum(WRITER_AGENT_ACTIONS), z.number().int().nonnegative()),
    preferredSections: z.array(z.string().regex(/^section_\d+$/)).max(WRITER_AGENT_MAX_SECTIONS),
    note: z.string().max(WRITER_AGENT_MAX_NOTE_CHARS).nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.stepCount !== value.steps.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stepCount'],
        message: 'Agent stepCount does not match the stored step count.',
      });
    }
    if (value.steps.length > value.maxSteps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: 'Agent stored more steps than its configured step budget.',
      });
    }
    for (let i = 0; i < value.steps.length; i += 1) {
      if (value.steps[i].index !== i) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps'],
          message: 'Agent step indices are not a contiguous ordered sequence.',
        });
        break;
      }
    }
    for (const action of WRITER_AGENT_ACTIONS) {
      const completed = value.steps.filter((step) => step.action === action && step.status === 'completed').length;
      if ((value.actionCounts[action] ?? 0) !== completed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actionCounts'],
          message: `Agent ${action} count does not match its completed steps.`,
        });
      }
    }
    if (value.status === 'idle' && (value.steps.length > 0 || value.startedAt !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'An idle agent cannot carry steps or a start timestamp.',
      });
    }
  });

/** Strict top-level schema for a persisted snapshot. `.strict()` fails closed
 *  on any field we did not intend to persist (context, secrets, internal
 *  handles...). Parsed values are narrowed to the WriterRunSnapshot shape by
 *  the parse helpers below (the schema itself infers plain strings for the
 *  branded runId). Revision/evidence/intelligence/agent fields are later
 *  additions: they default so older rows persisted earlier still parse. */
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
      'reviewing',
      'revising',
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
    revisionStatus: z.enum(['none', 'revising', 'completed', 'failed']).default('none'),
    revisionCount: z.number().int().nonnegative().default(0),
    lastRevisionAt: z.string().nullable().default(null),
    revisionNote: z.string().nullable().default(null),
    revisionRequest: writerRevisionRequestSchema.nullable().default(null),
    evidence: writerEvidenceSchema.nullable().default(null),
    intelligence: writerIntelligenceSchema.nullable().default(null),
    agent: writerAgentSchema.nullable().default(null),
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
  if (snapshot.revisionRequest !== null && snapshot.status !== 'revising') {
    writerSnapshotInvalid(runId, 'a revision request exists outside the revising state');
  }
  if (snapshot.status === 'revising' && snapshot.revisionRequest === null) {
    writerSnapshotInvalid(runId, 'a revising run has no revision request');
  }
  if (snapshot.evidence !== null && snapshot.evidence.gatheredAt === null) {
    writerSnapshotInvalid(runId, 'evidence exists without a gather timestamp');
  }
  if (snapshot.intelligence !== null && snapshot.intelligence.gatheredAt === null) {
    writerSnapshotInvalid(runId, 'intelligence exists without a gather timestamp');
  }
  if (snapshot.agent !== null) {
    const agent = snapshot.agent;
    if (agent.status !== 'idle' && agent.startedAt === null) {
      writerSnapshotInvalid(runId, 'a started agent has no start timestamp');
    }
    if (agent.status === 'running' && agent.finishedAt !== null) {
      writerSnapshotInvalid(runId, 'a running agent must not carry a finish timestamp');
    }
    if (agent.status === 'running' && snapshot.status !== 'review_ready') {
      writerSnapshotInvalid(runId, 'a running agent requires the run to rest on review_ready');
    }
    if (
      (agent.status === 'completed' || agent.status === 'limit_reached' || agent.status === 'failed') &&
      agent.finishedAt === null
    ) {
      writerSnapshotInvalid(runId, 'a finished agent has no finish timestamp');
    }
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
 *  here is a programmer error and throws. opts.revisionRequest lets a caller
 *  persist the validated request of a committed-but-unfinished revise round
 *  (the row is `revising` while the thread resumes); it is null otherwise. */
export function snapshotFromResult(
  result: WriterRunResult,
  opts: { revisionRequest?: WriterRevisionRequest | null } = {},
): WriterRunSnapshot {
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
    revisionStatus: result.revisionStatus,
    revisionCount: result.revisionCount,
    lastRevisionAt: result.lastRevisionAt,
    revisionNote: result.revisionNote,
    revisionRequest: opts.revisionRequest ?? null,
    evidence: result.evidence ?? null,
    intelligence: result.intelligence ?? null,
    agent: result.agent ?? null,
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
    revisionStatus: 'failed',
    revisionRequest: null,
    agent:
      snapshot.agent && snapshot.agent.status === 'running'
        ? {
            ...snapshot.agent,
            status: 'failed',
            note: note.slice(0, WRITER_AGENT_MAX_NOTE_CHARS),
            finishedAt: new Date().toISOString(),
          }
        : snapshot.agent,
  });
  if (!parsed.success) {
    throw new Error(`could not build failed snapshot for run ${snapshot.runId}`);
  }
  return parsed.data as WriterRunSnapshot;
}

/** Builds the snapshot that records the committed start of an agent run on a
 *  review_ready row: the run stays review_ready (the agent is a bounded loop on
 *  top of the resting state) while the safe agent intent is persisted as
 *  `running`, so a crash before/while the thread resumes can be recovered and
 *  the consumed steps are never re-run. */
export function agentCommittedSnapshot(
  snapshot: WriterRunSnapshot,
  agent: WriterAgentState,
): WriterRunSnapshot {
  const parsed = writerRunSnapshotSchema.safeParse({
    ...snapshot,
    status: 'review_ready',
    agent,
  });
  if (!parsed.success) {
    throw new Error(`could not build agent snapshot for run ${snapshot.runId}`);
  }
  return parsed.data as WriterRunSnapshot;
}

/** Builds the snapshot of a review_ready run whose revise round was just
 *  committed to the row: status moves to `revising`, revisionStatus to
 *  `revising`, and the validated request is persisted so a crash before the
 *  thread resume can re-issue the exact revise (see durable.ts). The existing
 *  review artifact is kept so the UI can keep showing the previous result while
 *  the revision runs. */
export function reviseCommittedSnapshot(
  snapshot: WriterRunSnapshot,
  request: WriterRevisionRequest,
): WriterRunSnapshot {
  const parsed = writerRunSnapshotSchema.safeParse({
    ...snapshot,
    status: 'revising',
    revisionStatus: 'revising',
    revisionNote: null,
    revisionRequest: request,
  });
  if (!parsed.success) {
    throw new Error(`could not build revising snapshot for run ${snapshot.runId}`);
  }
  return parsed.data as WriterRunSnapshot;
}
