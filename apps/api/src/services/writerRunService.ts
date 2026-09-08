/**
 * Writer integration service (SEO Core, W6).
 *
 * W6 wires the W0-W5 writer agent to the API/Content Studio. This service is
 * the thin application seam: it owns the process-local run store (runId bound
 * to exactly one projectId + contentId), builds the writer's dependency
 * allowlist from the existing container (read-only context adapters + AI
 * planner/section writer behind AIService.resolve), starts runs, resumes them
 * through the existing resumeWriterRun boundary and maps the resting run state
 * onto a safe API/UI DTO.
 *
 * Explicit W6 boundaries honoured here:
 *   - the writer remains an orchestration layer; this service never writes
 *     seo_content, never publishes and never schedules - a completed run only
 *     produces a review-ready artifact the human can inspect;
 *   - every operation resolves under the exact projectId+contentId a run was
 *     started for - a valid runId from project A can never be addressed
 *     through a URL of project B (fail closed with writer_run_not_found);
 *   - the run registry/checkpoint stays in-memory and process-local (W8 moves
 *     to durable storage); a lost run fails honestly instead of restarting;
 *   - an approve resume starts the W4+W5 phase in-process: the service tracks
 *     the run as `writing` until resumeWriterRun rests on a terminal state, so
 *     callers can poll the DTO without ever reading LangGraph checkpoint
 *     internals (and without racing the MemorySaver of the run's thread);
 *   - rejection resumes synchronously (it makes no AI/provider calls) and
 *     rests on `rejected`.
 */

import type { WriterRunDto } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { AIService } from './aiService.js';
import {
  createWriterRunRegistry,
  isWriterRunId,
  resumeWriterRun,
  runWriterOnce,
  type WriterApprovalDecision,
  type WriterPlan,
  type WriterReview,
  type WriterRunDependencies,
  type WriterRunId,
  type WriterRunRegistry,
  type WriterRunResult,
  type WriterStatus,
} from '../agents/writer/index.js';
import { createWriterContextDependencies } from '../agents/writer/contextDependencies.js';
import { createAiWriterPlanner, type WriterAiResolver } from '../agents/writer/planner.js';
import { createAiWriterSectionWriter } from '../agents/writer/sectionWriter.js';

// --- run store ---------------------------------------------------------------

/** One in-memory writer run the service knows about: the run's resting result
 *  snapshot plus the project/content binding it was started under. Only the
 *  snapshot is ever mapped onto a DTO - never the LangGraph checkpoint. */
export interface WriterRunRecord {
  runId: WriterRunId;
  projectId: string;
  contentId: string;
  createdAt: string;
  /** True while an approved run is actively writing (approve resume in
   *  flight); the run is surfaced as `writing` until the resume rests. */
  writing: boolean;
  /** The latest resting WriterRunResult (awaiting_approval / completed /
   *  rejected / failed). */
  result: WriterRunResult | null;
  /** Honest failure note when a resume itself failed out of band. */
  errorNote: string | null;
}

/** The in-memory store a WriterRunService instance works against: the runId ->
 *  record map plus the run registry (runId -> compiled graph owning that run's
 *  MemorySaver checkpoint). Created with createWriterRunStore() to scope runs
 *  per test/service instance; the default is a module-level singleton so HTTP
 *  handlers constructed per request share one process-local store. */
export interface WriterRunStore {
  records: Map<WriterRunId, WriterRunRecord>;
  registry: WriterRunRegistry;
}

/** Creates an empty run store. */
export function createWriterRunStore(): WriterRunStore {
  return { records: new Map(), registry: createWriterRunRegistry() };
}

const defaultStore: WriterRunStore = createWriterRunStore();

/** Returns the shared default run store (process-local, like the writer's own
 *  default registry: a restart loses every run and resume then fails with
 *  writer_run_not_found - honest, never a silent restart). */
export function defaultWriterRunStore(): WriterRunStore {
  return defaultStore;
}

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

// --- status mapping ----------------------------------------------------------

/** Maps the writer's resting status vocabulary onto the API/UI status union.
 *  The graph only ever rests on awaiting_approval / completed / rejected /
 *  failed (plus the service-side `writing` while an approve resume is in
 *  flight); the remaining runtime statuses are transient super-steps that are
 *  never observable in a returned result and are mapped for completeness. */
function mapStatus(status: WriterStatus): WriterRunDto['status'] {
  switch (status) {
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'completed':
      return 'completed';
    case 'rejected':
      return 'rejected';
    case 'failed':
      return 'failed';
    case 'writing':
      return 'writing';
    case 'review_ready':
      return 'review_ready';
    case 'planning':
      return 'planning';
    case 'running':
      return 'gathering_context';
    case 'idle':
    case 'cancelled':
      return 'failed';
    case 'approved':
      return 'writing';
  }
}

function toPlanDto(plan: WriterPlan | null): WriterRunDto['plan'] {
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

function toReviewDto(review: WriterReview | null): WriterRunDto['review'] {
  if (!review) return null;
  return { contentJson: review.contentJson, contentHtml: review.contentHtml, seo: review.seo };
}

/** Human note for the UI: the rejection reason, an honest failure message or
 *  null while a run is progressing normally. */
function noteFromResult(result: WriterRunResult | null): string | null {
  if (!result) return null;
  if (result.status === 'rejected') {
    return result.approvalReason ?? 'The proposed plan was rejected.';
  }
  if (result.status === 'failed') {
    return result.planNote ?? result.writeNote ?? result.reviewNote ?? 'The writer run failed.';
  }
  return null;
}

function toDto(record: WriterRunRecord): WriterRunDto {
  return {
    runId: record.runId,
    projectId: record.projectId,
    contentId: record.contentId,
    status: record.writing ? 'writing' : record.errorNote ? 'failed' : mapStatus(record.result?.status ?? 'idle'),
    plan: toPlanDto(record.result?.plan ?? null),
    review: toReviewDto(record.result?.review ?? null),
    note: record.errorNote ?? noteFromResult(record.result),
    createdAt: record.createdAt,
  };
}

// --- service -----------------------------------------------------------------

export interface WriterRunServiceOptions {
  /** Scoped run store; defaults to the module-level process-local singleton. */
  store?: WriterRunStore;
  /** Injectable writer dependencies (tests); defaults to the production
   *  container wiring via writerDependenciesFor. */
  deps?: WriterRunDependencies;
}

/** Start input already resolved against the content row by the route: the
 *  non-empty topic (instruction or content title) and optional target keyword. */
export interface WriterStartServiceInput {
  topic: string;
  targetKeyword?: string | null;
}

export class WriterRunService {
  private readonly store: WriterRunStore;
  private readonly deps: WriterRunDependencies | undefined;

  constructor(
    private readonly container: ServiceContainer,
    opts: WriterRunServiceOptions = {},
  ) {
    this.store = opts.store ?? defaultWriterRunStore();
    this.deps = opts.deps;
  }

  private depsFor(): WriterRunDependencies {
    return this.deps ?? writerDependenciesFor(this.container);
  }

  private requireBoundRun(runId: WriterRunId, projectId: string, contentId: string): WriterRunRecord {
    if (!isWriterRunId(runId)) {
      throw ApiError.badRequest('runId must be a writer run id (wr_<uuid>)', { runId });
    }
    const record = this.store.records.get(runId);
    if (!record || record.projectId !== projectId || record.contentId !== contentId) {
      throw new ApiError(
        404,
        'writer_run_not_found',
        'No writer run exists for this project/content. Writer runs live in memory and do not survive a process restart.',
        { runId },
      );
    }
    return record;
  }

  /** Starts a writer run for one project/content pair and returns the resting
   *  DTO (awaiting_approval with the proposed plan, or failed). */
  async start(projectId: string, contentId: string, input: WriterStartServiceInput): Promise<WriterRunDto> {
    const result = await runWriterOnce(
      {
        projectId,
        requestId: contentId,
        topic: input.topic,
        targetKeyword: input.targetKeyword ?? undefined,
      },
      this.depsFor(),
      this.store.registry,
    );
    const record: WriterRunRecord = {
      runId: result.runId,
      projectId,
      contentId,
      createdAt: new Date().toISOString(),
      writing: false,
      result,
      errorNote: null,
    };
    this.store.records.set(result.runId, record);
    return toDto(record);
  }

  /** Safe DTO for one run, strictly bound to the project/content pair in the
   *  URL. Unknown or mismatched run -> 404. */
  async getRun(runId: WriterRunId, projectId: string, contentId: string): Promise<WriterRunDto> {
    return toDto(this.requireBoundRun(runId, projectId, contentId));
  }

  /** Resolves an explicit approve/reject decision for a run that is resting on
   *  awaiting_approval. An approve starts the W4+W5 writing phase in-process
   *  and returns immediately with status `writing` so callers can poll
   *  getRun; a reject resumes synchronously (no AI/provider work) and returns
   *  the terminal `rejected` DTO. Wrong-state / unknown runs fail closed. */
  async decide(runId: WriterRunId, decision: WriterApprovalDecision, projectId: string, contentId: string): Promise<WriterRunDto> {
    const record = this.requireBoundRun(runId, projectId, contentId);
    const resting = record.result?.status;
    if (record.writing || resting !== 'awaiting_approval') {
      throw new ApiError(
        409,
        'writer_run_not_awaiting_approval',
        `Writer run ${runId} is ${record.writing ? 'writing' : resting}; only a run awaiting approval can be resumed.`,
        { runId, status: record.writing ? 'writing' : resting },
      );
    }

    if (decision.decision === 'reject') {
      const result = await resumeWriterRun({ runId, decision }, this.store.registry);
      record.writing = false;
      record.result = result;
      return toDto(record);
    }

    record.writing = true;
    void resumeWriterRun({ runId, decision }, this.store.registry)
      .then((result) => {
        record.writing = false;
        record.result = result;
        record.errorNote = null;
      })
      .catch((err: unknown) => {
        record.writing = false;
        record.errorNote = err instanceof Error ? err.message : 'The writer run could not be resumed.';
      });
    return toDto(record);
  }
}
