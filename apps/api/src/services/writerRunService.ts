/**
 * Writer integration service (SEO Core, W7 durable runs).
 *
 * W6 wired the W0-W5 writer agent to the API/Content Studio through a
 * process-local in-memory store + MemorySaver registry; W7 makes runs durable.
 * This service is the application seam that owns the durable run lifecycle:
 *
 *   - the run is recorded in seo_writer_runs (one row per run, bound to exactly
 *     one projectId + contentId, account mirrored from the project, safe
 *     WriterRunSnapshot in state_json) AND its LangGraph thread lives on the
 *     process-wide durable checkpointer (PostgresSaver over the direct pool,
 *     MemorySaver fallback - see writerCheckpointHost). The row is the safe
 *     external source of truth for the UI; the checkpointer is the
 *     authoritative execution state. A restart therefore never loses a run:
 *     getRun/decide read the row and continue the exact same thread.
 *   - start runs the initial thread (context + planning + human approval
 *     interrupt) and records the resting row (awaiting_approval or failed);
 *   - approve is committed to the row first (awaiting_approval -> writing)
 *     and only then resumes the thread in the background - so an approve can
 *     never be lost to a crash before it takes effect, and a row left on
 *     `writing` by a crash is recovered (see below). A fully written run now
 *     rests on `review_ready` (the W8 review-session pause), never `completed`;
 *   - reject resumes synchronously to rejected;
 *   - revise (W8) mirrors approve on a run resting on review_ready: it is
 *     committed to the row first (review_ready -> revising, carrying the
 *     validated revision request so a crash cannot lose it), then resumes the
 *     thread in the background; the run flows through the revision supersteps
 *     and the deterministic re-review and rests on review_ready again with a
 *     fresh artifact. `completed` is W8-graph-only (an explicit accept); this
 *     W8 service exposes no accept endpoint;
 *   - a getRun that finds a `writing`/`revising` row no longer being written by
 *     this process (a crash mid-run after a restart) triggers a background
 *     recovery that continues the exact same thread from its last persisted
 *     checkpoint: already-written/rewritten sections are never redone (each
 *     section is its own persisted superstep), a committed-but-unresumed revise
 *     is re-issued from the row's persisted request, the run is never
 *     re-planned, and the row catches up to the resting result. A row this
 *     process IS writing is simply reported as its in-progress status.
 *
 * Deny-by-default rules (W6 semantics preserved): a run is always addressed by
 * runId + the exact projectId+contentId it was started under (else 404
 * writer_run_not_found), malformed runId -> 400, invalid approval decision ->
 * 400 invalid_approval_decision, invalid review-session decision -> 400
 * invalid_review_session_decision, a run not resting on awaiting_approval ->
 * 409 writer_run_not_awaiting_approval, a run not resting on review_ready (for
 * revise) -> 409 writer_run_not_review_ready, a run whose checkpoint was lost
 * -> 404 writer_run_not_found (never a silent restart from START), a corrupt
 * persisted snapshot -> 500 writer_run_state_invalid. The service never
 * fabricates a plan, a section, a revision, a review or a metric.
 *
 * Explicit boundaries honoured (unchanged from W6): the writer stays an
 * orchestration layer - this service never writes seo_content, never publishes
 * and never schedules; only the safe WriterRunDto leaves this seam.
 *
 * Concurrency: approve + recovery are guarded by a process-wide in-flight set
 * (module-level by default, injectable per test) so the same run's thread is
 * never resumed twice in one process. Transitions are optimistic on the row
 * status, so a stale transition is a no-op, never a double write.
 */

import type { WriterRunDto } from '@seo/contracts';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { logger } from '../logger.js';
import { AIService } from './aiService.js';
import {
  createWriterRunId,
  isWriterRunId,
  parseWriterApprovalDecision,
  parseWriterSessionDecision,
  parseWriterMagicRequest,
  buildMagicRevisionRequest,
  magicResumeFromRequest,
  validateRevisionSectionIds,
  type WriterRunDependencies,
  type WriterRunId,
  type WriterRunResult,
  type WriterReviewSessionResume,
} from '../agents/writer/index.js';
import {
  continueDurableWriterRun,
  resumeDurableReviewSession,
  resumeDurableWriterRun,
  startDurableWriterRun,
} from '../agents/writer/durable.js';
import { createWriterContextDependencies } from '../agents/writer/contextDependencies.js';
import { createAiWriterPlanner, type WriterAiResolver } from '../agents/writer/planner.js';
import { createAiWriterRevisionWriter } from '../agents/writer/revisionWriter.js';
import { createAiWriterSectionWriter } from '../agents/writer/sectionWriter.js';
import { failedSnapshot, reviseCommittedSnapshot, snapshotFromResult } from '../agents/writer/snapshot.js';
import {
  SupabaseWriterRunRepository,
  type NewWriterRun,
  type WriterRunDbStatus,
  type WriterRunRepository,
  type WriterRunRow,
} from './writerRunRepository.js';
import { defaultWriterCheckpointProvider, type WriterCheckpointProvider } from './writerCheckpointHost.js';

/** Builds the writer dependency allowlist for a live service container: the
 *  read-only project context adapters plus AI planner/section writer/revision
 *  writer resolved through the existing AIService.resolve boundary. The
 *  deterministic review allowlist is left to its canonical contracts default. */
export function writerDependenciesFor(container: ServiceContainer): WriterRunDependencies {
  const ai = new AIService(container);
  const resolve: WriterAiResolver = async (projectId) => {
    const resolved = await ai.resolve(projectId);
    return { provider: resolved.provider, configured: resolved.configured };
  };
  return {
    context: createWriterContextDependencies(container),
    planner: createAiWriterPlanner(resolve),
    sectionWriter: createAiWriterSectionWriter(resolve),
    revisionWriter: createAiWriterRevisionWriter(resolve),
  };
}

// --- in-flight guard ---------------------------------------------------------

/** Process-wide set of writer run ids whose approve/resume is currently being
 *  written by this process. Shared across route service instances so a getRun
 *  never double-resumes a run an approve is already writing. */
const defaultInFlight = new Set<WriterRunId>();

/** Returns the shared process-wide in-flight set. */
export function defaultWriterInFlight(): Set<WriterRunId> {
  return defaultInFlight;
}

// --- status + DTO mapping ----------------------------------------------------

/** Maps a resting writer result onto the durable row status vocabulary. The
 *  resting statuses are awaiting_approval, review_ready (the W8 review-session
 *  pause - never terminal), completed/rejected/failed (terminal). A writer
 *  status that should never rest (a bug or a crash mid-flight) is surfaced as
 *  a failed run, never invented as progress. */
function resultToRowStatus(result: WriterRunResult): WriterRunDbStatus {
  switch (result.status) {
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'review_ready':
      return 'review_ready';
    case 'completed':
      return 'completed';
    case 'rejected':
      return 'rejected';
    case 'failed':
      return 'failed';
    default:
      return 'failed';
  }
}

/** Terminal row statuses: the only states a run can end in. review_ready rests
 *  (it waits on the review session) but is not terminal. */
function isTerminalRowStatus(status: WriterRunDbStatus): boolean {
  return status === 'completed' || status === 'rejected' || status === 'failed';
}

function toPlanDto(plan: WriterRunRow['snapshot']['plan']): WriterRunDto['plan'] {
  if (!plan) return null;
  return {
    title: plan.title,
    metaDescription: plan.metaDescription,
    introductionPurpose: plan.introductionPurpose,
    sections: plan.sections.map((s, index) => ({
      sectionId: `section_${index}`,
      heading: s.heading,
      keyPoints: s.keyPoints,
      suggestedKeywords: s.suggestedKeywords,
    })),
  };
}

function toReviewDto(review: WriterRunRow['snapshot']['review']): WriterRunDto['review'] {
  if (!review) return null;
  return { contentJson: review.contentJson, contentHtml: review.contentHtml, seo: review.seo };
}

/** Human note for the UI, derived from the safe snapshot only: the rejection
 *  reason, an honest failure message or null while a run is progressing. */
function noteForRow(row: WriterRunRow): string | null {
  if (row.status === 'rejected') {
    return row.snapshot.approvalReason ?? 'The proposed plan was rejected.';
  }
  if (row.status === 'failed') {
    return (
      row.snapshot.planNote ??
      row.snapshot.writeNote ??
      row.snapshot.reviewNote ??
      row.snapshot.revisionNote ??
      'The writer run failed.'
    );
  }
  return null;
}

/** The Section Magic action currently being applied to a run. Present only
 *  while the row is `revising` through a magic request (so the UI can say
 *  exactly what the AI is doing and that it is a proposal, not an
 *  auto-acceptance); null for a plain W8 revision or any non-revising state. */
function magicActionForRow(row: WriterRunRow): WriterRunDto['magicAction'] {
  if (row.status === 'revising' && row.snapshot.revisionRequest?.magic) {
    return row.snapshot.revisionRequest.magic.action;
  }
  return null;
}

/** Maps a durable row onto the safe API/UI DTO. The DTO status vocabulary and
 *  the row status vocabulary are the same strings, so the row status maps
 *  straight through; only the note is derived from the snapshot. */
function rowToDto(row: WriterRunRow): WriterRunDto {
  return {
    runId: row.runId,
    projectId: row.projectId,
    contentId: row.contentId,
    status: row.status,
    plan: toPlanDto(row.snapshot.plan),
    review: toReviewDto(row.snapshot.review),
    note: noteForRow(row),
    revisionCount: row.snapshot.revisionCount,
    lastRevisionAt: row.snapshot.lastRevisionAt,
    magicAction: magicActionForRow(row),
    createdAt: row.createdAt,
  };
}

// --- service -----------------------------------------------------------------

export interface WriterRunServiceOptions {
  /** Durable run repository; defaults to SupabaseWriterRunRepository over the
   *  container's service-role client. Tests inject an in-memory repository. */
  repository?: WriterRunRepository;
  /** Explicit shared checkpointer (tests). Defaults to the process-wide
   *  durable provider resolved from the container's direct Postgres pool. */
  checkpointer?: BaseCheckpointSaver;
  /** Injectable writer dependencies (tests); defaults to the production
   *  container wiring via writerDependenciesFor. */
  deps?: WriterRunDependencies;
  /** The authenticated user starting runs (writes seo_writer_runs.user_id). */
  actor?: { userId: string };
  /** Process-wide in-flight set; defaults to the shared module-level set. */
  inFlight?: Set<WriterRunId>;
}

/** Start input already resolved against the content row by the route: the
 *  non-empty topic (instruction or content title) and optional target keyword. */
export interface WriterStartServiceInput {
  topic: string;
  targetKeyword?: string | null;
}

export class WriterRunService {
  private readonly repository: WriterRunRepository;
  private readonly deps: WriterRunDependencies | undefined;
  private readonly checkpointerExplicit: BaseCheckpointSaver | undefined;
  private readonly checkpoints: WriterCheckpointProvider;
  private readonly actor: { userId: string } | null;
  private readonly inFlight: Set<WriterRunId>;

  constructor(
    private readonly container: ServiceContainer,
    opts: WriterRunServiceOptions = {},
  ) {
    this.repository = opts.repository ?? new SupabaseWriterRunRepository(container.sb);
    this.deps = opts.deps;
    this.checkpointerExplicit = opts.checkpointer;
    this.checkpoints = defaultWriterCheckpointProvider(container.pgPool);
    this.actor = opts.actor ?? null;
    this.inFlight = opts.inFlight ?? defaultInFlight;
  }

  private depsFor(): WriterRunDependencies {
    return this.deps ?? writerDependenciesFor(this.container);
  }

  private async checkpointer(): Promise<BaseCheckpointSaver> {
    return this.checkpointerExplicit ?? this.checkpoints.saver();
  }

  private async requireBoundRow(
    runId: WriterRunId,
    projectId: string,
    contentId: string,
  ): Promise<WriterRunRow> {
    if (!isWriterRunId(runId)) {
      throw ApiError.badRequest('runId must be a writer run id (wr_<uuid>)', { runId });
    }
    const row = await this.repository.getBound(runId, projectId, contentId);
    if (!row) {
      throw new ApiError(
        404,
        'writer_run_not_found',
        'No writer run exists for this project and content.',
        { runId },
      );
    }
    return row;
  }

  /** Optimistic transition that catches a row up to its resting result. The
   *  `from` set is the in-progress status(es) the caller committed, so a stale
   *  transition is a no-op (already recovered elsewhere). completed_at is only
   *  stamped on a terminal status: awaiting_approval and review_ready rest and
   *  are not terminal. */
  private async persistResting(
    binding: { runId: WriterRunId; projectId: string; contentId: string },
    result: WriterRunResult,
    from: readonly WriterRunDbStatus[],
  ): Promise<boolean> {
    const status = resultToRowStatus(result);
    return this.repository.transition({
      runId: binding.runId,
      projectId: binding.projectId,
      contentId: binding.contentId,
      from,
      to: status,
      snapshot: snapshotFromResult(result),
      completedAt: isTerminalRowStatus(status) ? new Date().toISOString() : null,
    });
  }

  /** Recovers a `writing` or `revising` row that this process is not currently
   *  writing (a crash after an approve/revise, found after a restart).
   *  Continues the exact same thread on the shared checkpointer and catches the
   *  row up; a thread that no longer exists is failed honestly instead of being
   *  restarted. For a `revising` row the committed revision request (persisted
   *  on the row) is handed to the continuation so a crash between the commit
   *  and the thread resume re-issues the exact revise instead of losing it. */
  private async recoverInProgress(row: WriterRunRow): Promise<void> {
    if (this.inFlight.has(row.runId)) return;
    this.inFlight.add(row.runId);
    try {
      const current = await this.repository.getBound(row.runId, row.projectId, row.contentId);
      if (!current) return;
      if (current.status !== 'writing' && current.status !== 'revising') return;
      const saver = await this.checkpointer();
      const revisionRequest = current.snapshot.revisionRequest;
      const reviewSessionResume: WriterReviewSessionResume | undefined = revisionRequest
        ? revisionRequest.magic
          ? magicResumeFromRequest(revisionRequest)
          : {
              action: 'revise',
              sectionIds: revisionRequest.sectionIds,
              instruction: revisionRequest.instruction,
            }
        : undefined;
      const result = await continueDurableWriterRun(row.runId, this.depsFor(), saver, {
        ...(reviewSessionResume ? { reviewSessionResume } : {}),
      });
      if (result === null) {
        await this.failInProgressRow(
          current,
          'The writer run checkpoint was lost and cannot be resumed after the restart.',
        );
        return;
      }
      await this.persistResting(
        { runId: current.runId, projectId: current.projectId, contentId: current.contentId },
        result,
        [current.status],
      );
    } catch (err) {
      logger.error({ err, runId: row.runId }, 'writer run recovery failed');
      try {
        const latest = await this.repository.getBound(row.runId, row.projectId, row.contentId);
        if (latest && (latest.status === 'writing' || latest.status === 'revising')) {
          await this.failInProgressRow(latest, this.safeFailureNote(err));
        }
      } catch {
        // The failed transition itself is best-effort; the row stays in
        // progress and the next read will retry recovery.
      }
    } finally {
      this.inFlight.delete(row.runId);
    }
  }

  /** Human-safe note for an out-of-band resume/recovery failure. ApiError
   *  messages are already user-safe; anything else is replaced with a generic
   *  honest message so no internal/driver detail ever reaches the DTO. */
  private safeFailureNote(err: unknown): string {
    return err instanceof ApiError
      ? err.message
      : 'The writer run could not be resumed; please start a new run.';
  }

  /** Optimistically fails a `writing`/`revising` row with an honest bounded
   *  note. */
  private async failInProgressRow(row: WriterRunRow, note: string): Promise<void> {
    await this.repository.transition({
      runId: row.runId,
      projectId: row.projectId,
      contentId: row.contentId,
      from: [row.status],
      to: 'failed',
      snapshot: failedSnapshot(row.snapshot, note),
      completedAt: new Date().toISOString(),
    });
  }

  /** Runs an approved resume to its resting state in the background and
   *  catches the row up. Owns its in-flight slot: it is only entered with the
   *  run already in this.inFlight (see decide), and removes it when the run
   *  rests (review_ready / terminal) or fails honestly - never before, so
   *  concurrent getRun recovery never double-resumes a thread this process is
   *  writing. A resume that throws before doing work (e.g. the thread already
   *  advanced past awaiting_approval on a crash) falls back to
   *  continueDurableWriterRun so the run is caught up instead of being failed. */
  private async resumeApprovalInBackground(
    runId: WriterRunId,
    projectId: string,
    contentId: string,
    decision: unknown,
  ): Promise<void> {
    try {
      const saver = await this.checkpointer();
      const deps = this.depsFor();
      let result: WriterRunResult | null;
      try {
        result = await resumeDurableWriterRun({ runId, decision }, deps, saver);
      } catch {
        result = await continueDurableWriterRun(runId, deps, saver);
      }
      if (result !== null) {
        await this.persistResting({ runId, projectId, contentId }, result, ['writing']);
        return;
      }
      const latest = await this.repository.getBound(runId, projectId, contentId);
      if (latest && latest.status === 'writing') {
        await this.failInProgressRow(
          latest,
          'The writer run checkpoint was lost and cannot be resumed after the restart.',
        );
      }
    } catch (err) {
      logger.error({ err, runId }, 'writer approve resume failed');
      try {
        const latest = await this.repository.getBound(runId, projectId, contentId);
        if (latest && latest.status === 'writing') {
          await this.failInProgressRow(latest, this.safeFailureNote(err));
        }
      } catch {
        // Best-effort; the row stays writing and a later read retries recovery.
      }
    } finally {
      this.inFlight.delete(runId);
    }
  }

  /** Runs a committed revise/magic resume to its resting state (review_ready
   *  again) in the background and catches the row up. Same ownership contract as
   *  resumeApprovalInBackground: only entered with the run already in
   *  this.inFlight (see revise/magic); a resume that throws (e.g. the thread
   *  already left the review session) falls back to continueDurableWriterRun so
   *  the run is caught up instead of being failed. */
  private async resumeReviseInBackground(
    runId: WriterRunId,
    projectId: string,
    contentId: string,
    resume: WriterReviewSessionResume,
  ): Promise<void> {
    try {
      const saver = await this.checkpointer();
      const deps = this.depsFor();
      let result: WriterRunResult | null;
      try {
        result = await resumeDurableReviewSession({ runId, decision: resume }, deps, saver);
      } catch {
        result = await continueDurableWriterRun(runId, deps, saver, { reviewSessionResume: resume });
      }
      if (result !== null) {
        await this.persistResting({ runId, projectId, contentId }, result, ['revising']);
        return;
      }
      const latest = await this.repository.getBound(runId, projectId, contentId);
      if (latest && latest.status === 'revising') {
        await this.failInProgressRow(
          latest,
          'The writer run checkpoint was lost and cannot be resumed after the restart.',
        );
      }
    } catch (err) {
      logger.error({ err, runId }, 'writer revise resume failed');
      try {
        const latest = await this.repository.getBound(runId, projectId, contentId);
        if (latest && latest.status === 'revising') {
          await this.failInProgressRow(latest, this.safeFailureNote(err));
        }
      } catch {
        // Best-effort; the row stays revising and a later read retries recovery.
      }
    } finally {
      this.inFlight.delete(runId);
    }
  }

  /** Starts a writer run for one project/content pair and returns the resting
   *  DTO (awaiting_approval with the proposed plan, or failed). The row is
   *  recorded only after the initial thread rests, so a caller always receives
   *  a durable run it can poll and resume. */
  async start(projectId: string, contentId: string, input: WriterStartServiceInput): Promise<WriterRunDto> {
    const saver = await this.checkpointer();
    const result = await startDurableWriterRun(
      {
        runId: createWriterRunId(),
        projectId,
        requestId: contentId,
        topic: input.topic,
        targetKeyword: input.targetKeyword ?? undefined,
      },
      this.depsFor(),
      saver,
    );
    const row: NewWriterRun = {
      runId: result.runId,
      accountId: null,
      projectId,
      contentId,
      userId: this.actor?.userId ?? null,
      status: resultToRowStatus(result),
      snapshot: snapshotFromResult(result),
    };
    await this.repository.insert(row);
    const stored = await this.requireBoundRow(result.runId, projectId, contentId);
    return rowToDto(stored);
  }

  /** Safe DTO for one run, strictly bound to the project/content pair in the
   *  URL. Unknown or mismatched run -> 404. A `writing`/`revising` row whose
   *  thread this process is not actively resuming (crash leftover after a
   *  restart) is recovered in the background while its in-progress status is
   *  reported to the caller. */
  async getRun(runId: WriterRunId, projectId: string, contentId: string): Promise<WriterRunDto> {
    const row = await this.requireBoundRow(runId, projectId, contentId);
    if ((row.status === 'writing' || row.status === 'revising') && !this.inFlight.has(row.runId)) {
      void this.recoverInProgress(row);
    }
    return rowToDto(row);
  }

  /** Resolves an explicit approve/reject decision for a run resting on
   *  awaiting_approval. A reject resumes synchronously to `rejected`. An
   *  approve commits the run to `writing` first (so the approval can never be
   *  lost to a crash), then resumes the W4+W5 thread in the background and
   *  returns `writing` immediately so callers can poll getRun. Wrong-state /
   *  unknown runs fail closed. */
  async decide(
    runId: WriterRunId,
    decision: unknown,
    projectId: string,
    contentId: string,
  ): Promise<WriterRunDto> {
    const row = await this.requireBoundRow(runId, projectId, contentId);
    if (row.status !== 'awaiting_approval') {
      throw new ApiError(
        409,
        'writer_run_not_awaiting_approval',
        `Writer run ${runId} is ${row.status}; only a run awaiting approval can be resumed.`,
        { runId, status: row.status },
      );
    }
    if (this.inFlight.has(runId)) {
      throw new ApiError(
        409,
        'writer_run_not_awaiting_approval',
        `Writer run ${runId} is already being written.`,
        { runId, status: 'writing' },
      );
    }

    const parsed = parseWriterApprovalDecision(decision);
    if (!parsed.ok) {
      throw new ApiError(400, 'invalid_approval_decision', parsed.note, { runId });
    }

    if (parsed.decision.decision === 'reject') {
      const saver = await this.checkpointer();
      const result = await resumeDurableWriterRun({ runId, decision: parsed.decision }, this.depsFor(), saver);
      const status = resultToRowStatus(result);
      await this.repository.transition({
        runId,
        projectId,
        contentId,
        from: ['awaiting_approval'],
        to: status,
        snapshot: snapshotFromResult(result),
        completedAt: new Date().toISOString(),
      });
      return rowToDto(await this.requireBoundRow(runId, projectId, contentId));
    }

    // Approve: claim the in-flight slot, commit the approval durably, then
    // resume the thread in the background. Claiming the slot BEFORE the row
    // transition closes the window where a concurrent getRun could see the new
    // `writing` row and start a recovery resume on the same thread.
    this.inFlight.add(runId);
    const committed = await this.repository.transition({
      runId,
      projectId,
      contentId,
      from: ['awaiting_approval'],
      to: 'writing',
      snapshot: row.snapshot,
      completedAt: null,
    });
    if (!committed) {
      this.inFlight.delete(runId);
      const latest = await this.requireBoundRow(runId, projectId, contentId);
      throw new ApiError(
        409,
        'writer_run_not_awaiting_approval',
        `Writer run ${runId} is ${latest.status}; only a run awaiting approval can be resumed.`,
        { runId, status: latest.status },
      );
    }
    // The background resume owns its in-flight slot and releases it once the
    // run rests (review_ready or terminal) or fails honestly - never before.
    void this.resumeApprovalInBackground(runId, projectId, contentId, parsed.decision);
    // Report `writing` from the row we just committed, deterministically: the
    // background may already have finished (fast tests) but the approve response
    // is the durable W6 contract - poll getRun for the resting state.
    return rowToDto({ ...row, status: 'writing' });
  }

  /** Starts a controlled revision round (W8) for a run resting on
   *  review_ready. Mirrors approve: the revise is validated and committed to
   *  the row first (review_ready -> revising, carrying the validated request so
   *  a crash cannot lose it), then the thread is resumed in the background and
   *  `revising` is returned immediately so callers can poll getRun. The run
   *  flows through one AI rewrite per requested section and the deterministic
   *  re-review, then rests on review_ready again with a fresh artifact and the
   *  revision counters bumped. Wrong-state / unknown runs fail closed.
   */
  async revise(
    runId: WriterRunId,
    decision: unknown,
    projectId: string,
    contentId: string,
  ): Promise<WriterRunDto> {
    const row = await this.requireBoundRow(runId, projectId, contentId);
    if (row.status !== 'review_ready') {
      throw new ApiError(
        409,
        'writer_run_not_review_ready',
        `Writer run ${runId} is ${row.status}; only a run resting on review_ready can be revised.`,
        { runId, status: row.status },
      );
    }
    if (this.inFlight.has(runId)) {
      throw new ApiError(
        409,
        'writer_run_not_review_ready',
        `Writer run ${runId} is already being revised.`,
        { runId, status: 'revising' },
      );
    }

    const parsed = parseWriterSessionDecision(decision);
    if (!parsed.ok || parsed.decision.action !== 'revise') {
      throw new ApiError(
        400,
        'invalid_review_session_decision',
        parsed.ok
          ? 'A revision must be requested with { action: "revise", sectionIds, instruction }; accepting is not available for this run.'
          : parsed.note,
        { runId },
      );
    }
    const plan = row.snapshot.plan;
    if (!plan) {
      throw new ApiError(
        500,
        'writer_run_state_invalid',
        'A review_ready writer run has no approved plan to revise.',
        { runId },
      );
    }
    const sectionValidation = validateRevisionSectionIds(plan, parsed.decision.sectionIds);
    if (!sectionValidation.ok) {
      throw new ApiError(400, 'invalid_revision_sections', sectionValidation.note, { runId });
    }
    const request = {
      sectionIds: sectionValidation.sectionIds,
      instruction: parsed.decision.instruction,
    };

    // Claim the in-flight slot, commit the revision durably (status + the
    // validated request), then resume the thread in the background. Claiming
    // the slot BEFORE the row transition closes the window where a concurrent
    // getRun could see the new `revising` row and start a recovery resume on
    // the same thread.
    this.inFlight.add(runId);
    const committed = await this.repository.transition({
      runId,
      projectId,
      contentId,
      from: ['review_ready'],
      to: 'revising',
      snapshot: reviseCommittedSnapshot(row.snapshot, request),
      completedAt: null,
    });
    if (!committed) {
      this.inFlight.delete(runId);
      const latest = await this.requireBoundRow(runId, projectId, contentId);
      throw new ApiError(
        409,
        'writer_run_not_review_ready',
        `Writer run ${runId} is ${latest.status}; only a run resting on review_ready can be revised.`,
        { runId, status: latest.status },
      );
    }
    // The background resume owns its in-flight slot and releases it once the
    // run rests on review_ready (or fails honestly) - never before.
    void this.resumeReviseInBackground(runId, projectId, contentId, {
      action: 'revise',
      sectionIds: request.sectionIds,
      instruction: request.instruction,
    });
    // Report `revising` from the row we just committed, deterministically: the
    // background may already have finished (fast tests) but the revise response
    // is the durable W8 contract - poll getRun for the resting review_ready.
    return rowToDto({
      ...row,
      status: 'revising',
      snapshot: reviseCommittedSnapshot(row.snapshot, request),
    });
  }

  /** Starts a controlled Section Magic round (W10.1) for a run resting on
   *  review_ready. Section Magic is an explicit, user-triggered transformation:
   *  the caller picks the sections and the action (never the AI), the request is
   *  strictly validated (bounded action/tone vocabulary, optional bounded user
   *  prose, plan re-validation through buildMagicRevisionRequest) and then flows
   *  through the exact W8 revision infrastructure as a validated revision
   *  request carrying magic intent metadata - there is no parallel system, no
   *  auto-acceptance and no lifecycle state beyond the existing
   *  `review_ready -> revising -> reviewing -> review_ready` round. Mirrors
   *  revise(): commit to the row first, resume the thread in the background,
   *  return `revising` so callers can poll. Wrong-state / unknown runs fail
   *  closed. */
  async magic(
    runId: WriterRunId,
    body: unknown,
    projectId: string,
    contentId: string,
  ): Promise<WriterRunDto> {
    const row = await this.requireBoundRow(runId, projectId, contentId);
    if (row.status !== 'review_ready') {
      throw new ApiError(
        409,
        'writer_run_not_review_ready',
        `Writer run ${runId} is ${row.status}; only a run resting on review_ready can be transformed.`,
        { runId, status: row.status },
      );
    }
    if (this.inFlight.has(runId)) {
      throw new ApiError(
        409,
        'writer_run_not_review_ready',
        `Writer run ${runId} is already being revised.`,
        { runId, status: 'revising' },
      );
    }

    const parsed = parseWriterMagicRequest(body);
    if (!parsed.ok) {
      throw new ApiError(400, 'invalid_magic_request', parsed.note, { runId });
    }
    const plan = row.snapshot.plan;
    if (!plan) {
      throw new ApiError(
        500,
        'writer_run_state_invalid',
        'A review_ready writer run has no approved plan to transform.',
        { runId },
      );
    }
    const built = buildMagicRevisionRequest(plan, parsed.request);
    if (!built.ok) {
      throw new ApiError(400, 'invalid_revision_sections', built.note, { runId });
    }
    const request = built.request;

    // Claim the in-flight slot, commit the magic round durably (status + the
    // validated request with its magic intent), then resume the thread in the
    // background. Claiming the slot BEFORE the row transition closes the window
    // where a concurrent getRun could see the new `revising` row and start a
    // recovery resume on the same thread.
    this.inFlight.add(runId);
    const committed = await this.repository.transition({
      runId,
      projectId,
      contentId,
      from: ['review_ready'],
      to: 'revising',
      snapshot: reviseCommittedSnapshot(row.snapshot, request),
      completedAt: null,
    });
    if (!committed) {
      this.inFlight.delete(runId);
      const latest = await this.requireBoundRow(runId, projectId, contentId);
      throw new ApiError(
        409,
        'writer_run_not_review_ready',
        `Writer run ${runId} is ${latest.status}; only a run resting on review_ready can be transformed.`,
        { runId, status: latest.status },
      );
    }
    // The background resume owns its in-flight slot and releases it once the
    // run rests on review_ready (or fails honestly) - never before.
    void this.resumeReviseInBackground(runId, projectId, contentId, magicResumeFromRequest(request));
    // Report `revising` from the row we just committed, deterministically: the
    // background may already have finished (fast tests) but the magic response
    // is the durable W10.1 contract - poll getRun for the resting review_ready.
    return rowToDto({
      ...row,
      status: 'revising',
      snapshot: reviseCommittedSnapshot(row.snapshot, request),
    });
  }
}
