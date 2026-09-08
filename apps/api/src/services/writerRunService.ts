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
 *     `writing` by a crash is recovered (see below);
 *   - reject resumes synchronously to rejected;
 *   - a getRun that finds a `writing` row no longer being written by this
 *     process (a crash mid-writing after a restart) triggers a background
 *     recovery that continues the exact same thread from its last persisted
 *     checkpoint: already-written sections are never rewritten (each section
 *     is its own persisted superstep), the run is never re-planned, and the
 *     row catches up to the resting result. A writing run that this process IS
 *     writing (approve in flight) is simply reported as `writing`.
 *
 * Deny-by-default rules (W6 semantics preserved): a run is always addressed by
 * runId + the exact projectId+contentId it was started under (else 404
 * writer_run_not_found), malformed runId -> 400, invalid approval decision ->
 * 400 invalid_approval_decision, a run not resting on awaiting_approval -> 409
 * writer_run_not_awaiting_approval, a run whose checkpoint was lost -> 404
 * writer_run_not_found (never a silent restart from START), a corrupt
 * persisted snapshot -> 500 writer_run_state_invalid. The service never
 * fabricates a plan, a section, a review or a metric.
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
  type WriterRunDependencies,
  type WriterRunId,
  type WriterRunResult,
} from '../agents/writer/index.js';
import {
  continueDurableWriterRun,
  resumeDurableWriterRun,
  startDurableWriterRun,
} from '../agents/writer/durable.js';
import { createWriterContextDependencies } from '../agents/writer/contextDependencies.js';
import { createAiWriterPlanner, type WriterAiResolver } from '../agents/writer/planner.js';
import { createAiWriterSectionWriter } from '../agents/writer/sectionWriter.js';
import { failedSnapshot, snapshotFromResult } from '../agents/writer/snapshot.js';
import {
  SupabaseWriterRunRepository,
  type NewWriterRun,
  type WriterRunDbStatus,
  type WriterRunRepository,
  type WriterRunRow,
} from './writerRunRepository.js';
import { defaultWriterCheckpointProvider, type WriterCheckpointProvider } from './writerCheckpointHost.js';

/** Builds the writer dependency allowlist for a live service container: the
 *  read-only project context adapters plus AI planner/section writer resolved
 *  through the existing AIService.resolve boundary. The deterministic W5
 *  review allowlist is left to its canonical contracts default. */
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

/** Maps a resting writer result onto the durable row status vocabulary. A
 *  writer status that should never rest (a bug or a crash mid-flight) is
 *  surfaced as a failed run, never invented as progress. */
function resultToRowStatus(result: WriterRunResult): WriterRunDbStatus {
  switch (result.status) {
    case 'awaiting_approval':
      return 'awaiting_approval';
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

function toPlanDto(plan: WriterRunRow['snapshot']['plan']): WriterRunDto['plan'] {
  if (!plan) return null;
  return {
    title: plan.title,
    metaDescription: plan.metaDescription,
    introductionPurpose: plan.introductionPurpose,
    sections: plan.sections.map((s) => ({
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
      'The writer run failed.'
    );
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

  /** Optimistic terminal transition for a writing run; a no-op (false) when
   *  the row is no longer on `writing` (already recovered elsewhere). */
  private async persistResting(
    binding: { runId: WriterRunId; projectId: string; contentId: string },
    result: WriterRunResult,
  ): Promise<boolean> {
    const status = resultToRowStatus(result);
    return this.repository.transition({
      runId: binding.runId,
      projectId: binding.projectId,
      contentId: binding.contentId,
      from: ['writing'],
      to: status,
      snapshot: snapshotFromResult(result),
      completedAt: status === 'writing' ? null : new Date().toISOString(),
    });
  }

  /** Recovers a `writing` row that this process is not currently writing (a
   *  crash after an approve, found after a restart). Continues the exact same
   *  thread on the shared checkpointer and catches the row up; a thread that
   *  no longer exists is failed honestly instead of being restarted. */
  private async recoverWriting(row: WriterRunRow): Promise<void> {
    if (this.inFlight.has(row.runId)) return;
    this.inFlight.add(row.runId);
    try {
      const current = await this.repository.getBound(row.runId, row.projectId, row.contentId);
      if (!current || current.status !== 'writing') return;
      const saver = await this.checkpointer();
      const result = await continueDurableWriterRun(row.runId, this.depsFor(), saver);
      if (result === null) {
        await this.failWritingRow(
          current,
          'The writer run checkpoint was lost and cannot be resumed after the restart.',
        );
        return;
      }
      await this.persistResting({ runId: current.runId, projectId: current.projectId, contentId: current.contentId }, result);
    } catch (err) {
      logger.error({ err, runId: row.runId }, 'writer run recovery failed');
      try {
        const latest = await this.repository.getBound(row.runId, row.projectId, row.contentId);
        if (latest && latest.status === 'writing') {
          await this.failWritingRow(latest, this.safeFailureNote(err));
        }
      } catch {
        // The failed transition itself is best-effort; the row stays writing
        // and the next read will retry recovery.
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

  /** Optimistically fails a `writing` row with an honest bounded note. */
  private async failWritingRow(row: WriterRunRow, note: string): Promise<void> {
    await this.repository.transition({
      runId: row.runId,
      projectId: row.projectId,
      contentId: row.contentId,
      from: ['writing'],
      to: 'failed',
      snapshot: failedSnapshot(row.snapshot, note),
      completedAt: new Date().toISOString(),
    });
  }

  /** Runs an approved resume to its resting state in the background and
  *   catches the row up. Owns its in-flight slot: it is only entered with the
  *   run already in this.inFlight (see decide), and removes it when the run
  *   rests (terminal) or fails honestly - never before, so concurrent getRun
  *   recovery never double-resumes a thread this process is writing. A resume
  *   that throws before doing work (e.g. the thread already advanced past
  *   awaiting_approval on a crash) falls back to continueDurableWriterRun so
  *   the run is caught up instead of being failed. */
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
        await this.persistResting({ runId, projectId, contentId }, result);
        return;
      }
      const latest = await this.repository.getBound(runId, projectId, contentId);
      if (latest && latest.status === 'writing') {
        await this.failWritingRow(
          latest,
          'The writer run checkpoint was lost and cannot be resumed after the restart.',
        );
      }
    } catch (err) {
      logger.error({ err, runId }, 'writer approve resume failed');
      try {
        const latest = await this.repository.getBound(runId, projectId, contentId);
        if (latest && latest.status === 'writing') {
          await this.failWritingRow(latest, this.safeFailureNote(err));
        }
      } catch {
        // Best-effort; the row stays writing and a later read retries recovery.
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
   *  URL. Unknown or mismatched run -> 404. A `writing` run whose thread this
   *  process is not actively writing (crash leftover after a restart) is
   *  recovered in the background while `writing` is reported to the caller. */
  async getRun(runId: WriterRunId, projectId: string, contentId: string): Promise<WriterRunDto> {
    const row = await this.requireBoundRow(runId, projectId, contentId);
    if (row.status === 'writing' && !this.inFlight.has(row.runId)) {
      void this.recoverWriting(row);
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
    // run rests (terminal) or fails honestly - never before.
    void this.resumeApprovalInBackground(runId, projectId, contentId, parsed.decision);
    // Report `writing` from the row we just committed, deterministically: the
    // background may already have finished (fast tests) but the approve response
    // is the durable W6 contract - poll getRun for the terminal state.
    return rowToDto({ ...row, status: 'writing' });
  }
}
