/**
 * Durable agent run service (Stage 8E.6, ADR Phase 4 Part 1 + Part 2).
 *
 * The durable submission boundary for a Designer run: validate -> idempotency ->
 * persist the run and associate the job that will execute it. It deliberately
 * does NOT run the Designer at submission time: execution is the `agent_design`
 * worker executor (Phase 4 Part 2), which delegates back into
 * `executeDesignRun` so the run lifecycle and the Designer invocation live in
 * one place. Keeping submission cheap is the whole point of the durable run
 * model - an HTTP handler must not block on the planner + executor.
 *
 * Idempotency reuses the platform convention: an optional client key, stored on
 * the run and guarded by a project-scoped unique index. A duplicate submission
 * returns the existing run (and never enqueues a second job); NULL keys are not
 * deduplicated. The run row is created before its job because the run is the
 * stable external identity callers receive; the association is recorded with
 * `job_id`, and the job params carry the run id.
 *
 * Lifecycle (Phase 4 Part 2): `queued -> running -> succeeded | failed`.
 * `executeDesignRun` claims the run, runs the Designer, and only ever persists
 * the validated `DesignerProposal` as the run result before flipping to
 * `succeeded`. Transitions are optimistic (`from`-guarded), so a duplicate
 * delivery can never overwrite a terminal run. A retryable failure that the job
 * will retry leaves the run `running`; only the terminal attempt records the
 * structured `AgentRunError` and `failed`.
 *
 * `reconcileOrphanedRuns` repairs the one gap the queue cannot: a crash between
 * persisting a queued run and recording its job. It re-enqueues with the SAME
 * run-derived idempotency key, so it can never create a second job, and fails
 * closed on ambiguity.
 */

import { randomUUID } from 'node:crypto';
import {
  AGENT_RUN_ERROR_CODE_MAX_CHARS,
  AGENT_RUN_ERROR_MESSAGE_MAX_CHARS,
  AGENT_RUN_IDEMPOTENCY_KEY_MAX_CHARS,
  AGENT_RUN_ID_PREFIX,
  isAgentRunId,
  isTerminalAgentRunStatus,
  isValidAgentRunInput,
  type AgentRun,
  type AgentRunError,
  type AgentRunId,
  type AgentRunInput,
  type DesignBrief,
  type DesignerIntent,
  type DesignerPlan,
  type DesignerProposal,
  type ImageInsertionContext,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { jobErrorPayload, type JobRecord } from '../jobs/types.js';
import { logger } from '../logger.js';
import { DesignerService } from './designerService.js';
import {
  SupabaseAgentRunRepository,
  type AgentRunRepository,
  type AgentRunRow,
  type NewAgentRun,
} from './agentRunRepository.js';

/** Job identity carried by a durable agent run. */
export const AGENT_DESIGN_JOB_TYPE = 'agent_design';
export const AGENT_DESIGN_JOB_PROVIDER = 'designer';

/** How long a jobless queued run may rest before reconciliation adopts it. */
export const AGENT_RUN_ORPHAN_GRACE_MS = 60_000;
/** Per-sweep reconciliation bound; keeps a backlog from monopolizing a cycle. */
export const AGENT_RUN_RECONCILE_MAX_PER_SWEEP = 25;
/** Fallback error code when a failure surfaces no usable application code. */
const AGENT_RUN_ERROR_CODE_FALLBACK = 'agent_design_failed';

/** Generate an opaque external agent run id (`ar_<uuid>`). */
export function createAgentRunId(): AgentRunId {
  return `${AGENT_RUN_ID_PREFIX}${randomUUID()}`;
}

/** A plan-mode submission: explicit validated plan, optional brief/base revision. */
export interface AgentRunPlanSubmission {
  mode: 'plan';
  plan: DesignerPlan;
  brief?: DesignBrief;
  contentId?: string;
  baseRevision?: string;
  idempotencyKey?: string;
}

/** An intent-mode submission: natural language, optional brief/base revision. */
export interface AgentRunIntentSubmission {
  mode: 'intent';
  instruction: string;
  contentId?: string;
  baseRevision?: string;
  /**
   * Validated R3.1 editor context (canonical snapshot + revision + insertion
   * target). Carried opaquely through the durable intent as
   * `context.selection`; the Designer only acts on it for image insertion.
   */
  editorContext?: ImageInsertionContext;
  brief?: DesignBrief;
  idempotencyKey?: string;
}

export type AgentRunSubmission = AgentRunPlanSubmission | AgentRunIntentSubmission;

export interface AgentRunSubmitResult {
  run: AgentRun;
  /** True when a previously submitted run with the same key was returned. */
  reused: boolean;
}

/** Outcome of claiming a run for execution. `terminal` means do not execute. */
export type AgentRunBeginResult =
  | { kind: 'execute'; row: AgentRunRow }
  | { kind: 'terminal'; row: AgentRunRow };

/** Bounded, repeat-safe reconciliation sweep result. */
export interface AgentRunReconcileResult {
  examined: number;
  reconciled: number;
  skipped: number;
}

/** Normalize an arbitrary failure into the bounded, secret-free run error. */
function toAgentRunError(code: string | null | undefined, message: string, retryable: boolean): AgentRunError {
  const sanitized = (code ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const safeCode =
    sanitized.length > 0 && sanitized.length <= AGENT_RUN_ERROR_CODE_MAX_CHARS ? sanitized : AGENT_RUN_ERROR_CODE_FALLBACK;
  const safeMessage = message.length > 0 ? message.slice(0, AGENT_RUN_ERROR_MESSAGE_MAX_CHARS) : 'The design run failed.';
  return { code: safeCode, message: safeMessage, retryable };
}

/** Map a persisted row onto the public, contract-shaped run (no internal ids). */
export function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    runId: row.runId,
    kind: row.kind,
    projectId: row.projectId,
    status: row.status,
    input: row.input,
    result: row.result,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export class AgentRunService {
  private readonly repository: AgentRunRepository;

  constructor(
    private readonly container: ServiceContainer,
    repository?: AgentRunRepository,
  ) {
    this.repository = repository ?? new SupabaseAgentRunRepository(container.sb);
  }

  /** Translate a submission into the durable run input, validating at the edge. */
  private toInput(projectId: string, submission: AgentRunSubmission): NewAgentRun['input'] {
    if (submission.mode === 'plan') {
      const input = {
        mode: 'plan' as const,
        plan: submission.plan,
        ...(submission.brief !== undefined ? { brief: submission.brief } : {}),
        ...(submission.contentId !== undefined ? { contentId: submission.contentId } : {}),
        ...(submission.baseRevision !== undefined ? { baseRevision: submission.baseRevision } : {}),
      };
      if (!isValidAgentRunInput(input)) throw ApiError.badRequest('Invalid agent run input');
      return input;
    }
    const intent: DesignerIntent = {
      instruction: submission.instruction,
      projectId,
      ...(submission.contentId !== undefined ? { contentId: submission.contentId } : {}),
      ...(submission.brief !== undefined ? { brief: submission.brief } : {}),
      ...(submission.editorContext !== undefined
        ? { context: { selection: submission.editorContext } }
        : {}),
    };
    const input = {
      mode: 'intent' as const,
      intent,
      ...(submission.baseRevision !== undefined ? { baseRevision: submission.baseRevision } : {}),
    };
    if (!isValidAgentRunInput(input)) throw ApiError.badRequest('Invalid agent run input');
    return input;
  }

  /**
   * Persist one durable design run and associate its job. Idempotent on an
   * optional client key: a duplicate returns the existing run without creating a
   * second job. Never executes the Designer.
   */
  async submitDesignRun(
    projectId: string,
    userId: string,
    submission: AgentRunSubmission,
  ): Promise<AgentRunSubmitResult> {
    const key = submission.idempotencyKey?.trim();
    if (key !== undefined && (key.length === 0 || key.length > AGENT_RUN_IDEMPOTENCY_KEY_MAX_CHARS)) {
      throw ApiError.badRequest('Invalid idempotency key');
    }

    if (key) {
      const existing = await this.repository.getByProjectAndKey(projectId, key);
      if (existing) return { run: toAgentRun(existing), reused: true };
    }

    const input = this.toInput(projectId, submission);
    const runId = createAgentRunId();

    try {
      await this.repository.insert({
        runId,
        accountId: null,
        projectId,
        kind: 'design',
        status: 'queued',
        input,
        idempotencyKey: key ?? null,
        userId,
      });
    } catch (err) {
      // A concurrent submission won the idempotency key; reuse its run.
      if (key) {
        const winner = await this.repository.getByProjectAndKey(projectId, key);
        if (winner) return { run: toAgentRun(winner), reused: true };
      }
      throw err;
    }

    let job: JobRecord;
    try {
      job = await this.container.jobStore.enqueue({
        project_id: projectId,
        provider: AGENT_DESIGN_JOB_PROVIDER,
        job_type: AGENT_DESIGN_JOB_TYPE,
        params: { run_id: runId, kind: 'design' },
        created_by: userId,
        idempotency_key: `${AGENT_DESIGN_JOB_TYPE}:${runId}`,
      });
    } catch (err) {
      // The run exists but has no executable job. Record the honest failure so
      // the run never masquerades as queued, then surface the real error.
      await this.markEnqueueFailed(projectId, runId, err);
      throw err;
    }

    await this.repository.setJobId(runId, projectId, job.id);
    const run = await this.repository.getBound(runId, projectId);
    if (!run) {
      throw new ApiError(500, 'agent_run_persist_failed', 'Agent run disappeared after creation.', { runId });
    }
    return { run: toAgentRun(run), reused: false };
  }

  /** Fetch one run inside the authorized project scope, or null. */
  async getRun(projectId: string, runId: string): Promise<AgentRun | null> {
    const row = await this.repository.getBound(runId as AgentRunId, projectId);
    return row ? toAgentRun(row) : null;
  }

  /**
   * Claim a run for execution. A queued run is optimistically moved to
   * `running`; a run already `running` is returned as-is (a retry of the same
   * job re-enters it). A terminal run is returned as `terminal` so the caller
   * never re-executes or overwrites it. Returns null when the run is not bound
   * to this project.
   */
  async beginExecution(projectId: string, runId: AgentRunId): Promise<AgentRunBeginResult | null> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await this.repository.getBound(runId, projectId);
      if (!row) return null;
      if (isTerminalAgentRunStatus(row.status)) return { kind: 'terminal', row };
      if (row.status === 'running') return { kind: 'execute', row };
      const claimed = await this.repository.transition({ runId, projectId, from: ['queued'], to: 'running' });
      if (claimed) {
        const running = await this.repository.getBound(runId, projectId);
        return running ? { kind: 'execute', row: running } : null;
      }
    }
    throw new ApiError(500, 'agent_run_state_invalid', 'Agent run could not be claimed for execution.');
  }

  /**
   * Execute one durable design run and persist its terminal outcome. This is
   * the body of the `agent_design` worker executor: the executor only resolves
   * the run id from the job, and every lifecycle rule stays here. A terminal
   * run is never re-executed. On failure the run is failed only when the job
   * itself will not be retried; otherwise it stays `running` so the next
   * attempt re-enters (never a fake terminal failure).
   */
  async executeDesignRun(
    job: JobRecord,
    report: (progress: number, message?: string) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const rawRunId = typeof job.params?.run_id === 'string' ? job.params.run_id : '';
    if (!isAgentRunId(rawRunId)) {
      throw ApiError.badRequest('agent_design requires a valid run_id');
    }
    const runId: AgentRunId = rawRunId;
    const projectId = job.project_id;

    const begin = await this.beginExecution(projectId, runId);
    if (!begin) {
      throw new ApiError(404, 'agent_run_not_found', 'No agent run is bound to this job.', { runId });
    }
    if (begin.kind === 'terminal') {
      if (begin.row.status === 'succeeded') {
        return { run_id: runId, status: 'succeeded', already_terminal: true };
      }
      throw new ApiError(409, 'agent_run_terminal_failed', begin.row.error?.message ?? 'This agent run already failed.', {
        runId,
      });
    }

    const input: AgentRunInput = begin.row.input;
    let proposal: DesignerProposal;
    try {
      proposal = await this.runDesigner(projectId, input, report);
    } catch (err) {
      await this.recordRunFailure(job, projectId, runId, err);
      throw err;
    }

    const persisted = await this.repository.transition({
      runId,
      projectId,
      from: ['running'],
      to: 'succeeded',
      result: proposal,
      error: null,
      completedAt: new Date().toISOString(),
    });
    if (!persisted) {
      // A concurrent delivery reached a terminal state first; never overwrite it.
      const latest = await this.repository.getBound(runId, projectId);
      if (latest?.status === 'succeeded') {
        return { run_id: runId, status: 'succeeded', already_terminal: true };
      }
      if (latest?.status === 'failed') {
        throw new ApiError(409, 'agent_run_terminal_failed', latest.error?.message ?? 'This agent run already failed.', {
          runId,
        });
      }
      throw new ApiError(500, 'agent_run_state_invalid', 'Agent run could not be marked succeeded.', { runId });
    }
    await report(100, 'Design run complete');
    return {
      run_id: runId,
      status: 'succeeded',
      base_revision: proposal.baseRevision,
      document_version: proposal.document.version,
    };
  }

  /** Invoke the Designer exactly as the synchronous routes do, never writing. */
  private async runDesigner(
    projectId: string,
    input: AgentRunInput,
    report: (progress: number, message?: string) => Promise<void>,
  ): Promise<DesignerProposal> {
    if (input.mode === 'plan') {
      await report(10, 'Executing the design plan');
      return new DesignerService(this.container).execute(projectId, {
        plan: input.plan,
        ...(input.brief !== undefined ? { brief: input.brief } : {}),
        ...(input.contentId !== undefined ? { contentId: input.contentId } : {}),
        ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
      });
    }
    await report(10, 'Planning and executing the design intent');
    return new DesignerService(this.container, { llmPlanner: true }).executeIntent(projectId, input.intent, {
      ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
    });
  }

  /**
   * Record a failure on the run only when the job will not be retried. While
   * attempts remain the run stays `running` and the worker requeues the job,
   * so a transient failure never becomes a fake terminal run failure.
   */
  private async recordRunFailure(job: JobRecord, projectId: string, runId: AgentRunId, err: unknown): Promise<void> {
    const { error, retryable } = jobErrorPayload(err, {
      provider: job.provider,
      operation: job.job_type,
      project_id: projectId,
      job_type: job.job_type,
    });
    const willRetry = retryable && job.retry_count + 1 <= job.max_retries;
    if (willRetry) return;
    await this.repository.transition({
      runId,
      projectId,
      from: ['running'],
      to: 'failed',
      error: toAgentRunError(error.code, error.message, retryable),
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Adopt jobless queued runs. A run only becomes an orphan when a submission
   * was interrupted between persisting the run and recording its job, so the
   * repair re-enqueues with the run-derived idempotency key the original
   * submission would have used. That key makes the sweep repeat-safe and
   * concurrent-safe: a conflict means an equivalent job already exists and will
   * execute the run, and this function never enqueues a second job.
   */
  async reconcileOrphanedRuns(
    options: { olderThanMs?: number; limit?: number } = {},
  ): Promise<AgentRunReconcileResult> {
    const olderThanMs = options.olderThanMs ?? AGENT_RUN_ORPHAN_GRACE_MS;
    const limit = Math.max(1, Math.min(options.limit ?? AGENT_RUN_RECONCILE_MAX_PER_SWEEP, 100));
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const orphans = await this.repository.listOrphaned(cutoff, limit);

    let reconciled = 0;
    let skipped = 0;
    for (const orphan of orphans) {
      // Re-read to close the race with a submission that just recorded its job.
      const current = await this.repository.getBound(orphan.runId, orphan.projectId);
      if (!current || current.status !== 'queued' || current.jobId !== null) {
        skipped += 1;
        continue;
      }
      try {
        const job = await this.container.jobStore.enqueue({
          project_id: current.projectId,
          provider: AGENT_DESIGN_JOB_PROVIDER,
          job_type: AGENT_DESIGN_JOB_TYPE,
          params: { run_id: current.runId, kind: current.kind },
          created_by: current.userId,
          idempotency_key: `${AGENT_DESIGN_JOB_TYPE}:${current.runId}`,
        });
        await this.repository.setJobId(current.runId, current.projectId, job.id);
        reconciled += 1;
      } catch (err) {
        // A conflict means an equivalent job already exists; any other error is
        // transient. Neither may create a second job, so both fail closed.
        if (!(err instanceof ApiError && err.code === 'conflict')) {
          logger.warn({ err, runId: current.runId }, 'agent run reconciliation failed');
        }
        skipped += 1;
      }
    }
    return { examined: orphans.length, reconciled, skipped };
  }

  private async markEnqueueFailed(projectId: string, runId: AgentRunId, err: unknown): Promise<void> {
    const apiError = err instanceof ApiError ? err : null;
    const error: AgentRunError = {
      code: apiError?.code ?? 'job_enqueue_failed',
      message: err instanceof Error ? err.message : 'Could not enqueue the agent run job.',
      retryable: false,
    };
    await this.repository.transition({
      runId,
      projectId,
      from: ['queued'],
      to: 'failed',
      error,
      completedAt: new Date().toISOString(),
    });
  }
}
