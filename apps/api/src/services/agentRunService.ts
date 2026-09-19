/**
 * Durable agent run service (Stage 8E.6, ADR Phase 4 Part 1).
 *
 * The durable submission boundary for a Designer run: validate -> idempotency ->
 * persist the run and associate the job that will execute it. It deliberately
 * does NOT run the Designer: execution, retries and the status API are Phase 4
 * Part 2 (a worker executor for `agent_design`). Keeping submission cheap is the
 * whole point of the durable run model - an HTTP handler must not block on the
 * planner + executor.
 *
 * Idempotency reuses the platform convention: an optional client key, stored on
 * the run and guarded by a project-scoped unique index. A duplicate submission
 * returns the existing run (and never enqueues a second job); NULL keys are not
 * deduplicated. The run row is created before its job because the run is the
 * stable external identity callers receive; the association is recorded with
 * `job_id`, and the job params carry the run id.
 */

import { randomUUID } from 'node:crypto';
import {
  AGENT_RUN_IDEMPOTENCY_KEY_MAX_CHARS,
  AGENT_RUN_ID_PREFIX,
  isValidAgentRunInput,
  type AgentRun,
  type AgentRunError,
  type AgentRunId,
  type DesignBrief,
  type DesignerIntent,
  type DesignerPlan,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import type { JobRecord } from '../jobs/types.js';
import {
  SupabaseAgentRunRepository,
  type AgentRunRepository,
  type AgentRunRow,
  type NewAgentRun,
} from './agentRunRepository.js';

/** Job identity carried by a durable agent run. */
export const AGENT_DESIGN_JOB_TYPE = 'agent_design';
export const AGENT_DESIGN_JOB_PROVIDER = 'designer';

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
  brief?: DesignBrief;
  idempotencyKey?: string;
}

export type AgentRunSubmission = AgentRunPlanSubmission | AgentRunIntentSubmission;

export interface AgentRunSubmitResult {
  run: AgentRun;
  /** True when a previously submitted run with the same key was returned. */
  reused: boolean;
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
