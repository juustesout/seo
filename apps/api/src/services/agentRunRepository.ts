/**
 * Durable agent run repository (Stage 8E.6, ADR Phase 4 Part 1).
 *
 * `seo_agent_runs` is the safe external source of truth for an agent request:
 * its row is bound to exactly one projectId (+ optional account and the user
 * who started it), its status is the safe lifecycle vocabulary, and
 * input_json / result_json / error_json hold only validated contract values
 * (see `@seo/contracts/agentRun`).
 *
 * The repository is deliberately narrow and binding-aware: every read and every
 * lifecycle transition filters on run_id AND project_id, so a runId alone is
 * never enough to address a row (project membership authorization on top stays
 * the responsibility of the access service / routes). Transitions are
 * optimistic (`from` is part of the UPDATE), which is what makes a duplicate
 * executor unable to corrupt a terminal run.
 *
 * Two implementations share this contract: a Supabase (service-role) one used
 * in production and an in-memory one used by tests.
 */

import {
  isAgentRunId,
  isValidAgentRunError,
  isValidAgentRunInput,
  isValidDesignerProposal,
  AGENT_RUN_KINDS,
  AGENT_RUN_STATUSES,
  type AgentRunError,
  type AgentRunId,
  type AgentRunInput,
  type AgentRunKind,
  type AgentRunStatus,
  type DesignerProposal,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';
import type { createAdminClient } from '../supabase.js';

/** A run row as the service sees it: binding + safe status + validated values. */
export interface AgentRunRow {
  runId: AgentRunId;
  accountId: string | null;
  projectId: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  input: AgentRunInput;
  result: DesignerProposal | null;
  error: AgentRunError | null;
  jobId: string | null;
  userId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface NewAgentRun {
  runId: AgentRunId;
  accountId: string | null;
  projectId: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  input: AgentRunInput;
  jobId?: string | null;
  idempotencyKey?: string | null;
  userId: string | null;
}

/** A single optimistic lifecycle transition, always scoped to the full binding. */
export interface AgentRunTransition {
  runId: AgentRunId;
  projectId: string;
  from: readonly AgentRunStatus[];
  to: AgentRunStatus;
  result?: DesignerProposal | null;
  error?: AgentRunError | null;
  completedAt?: string | null;
}

export interface AgentRunRepository {
  insert(run: NewAgentRun): Promise<void>;
  /** Bound read; null when no row matches run_id + project_id. */
  getBound(runId: AgentRunId, projectId: string): Promise<AgentRunRow | null>;
  /** Idempotency read-back, scoped to the project. */
  getByProjectAndKey(projectId: string, idempotencyKey: string): Promise<AgentRunRow | null>;
  /** Associate (or clear) the job that carries this run's execution. */
  setJobId(runId: AgentRunId, projectId: string, jobId: string | null): Promise<void>;
  /** Optimistic transition; false when no row was in `from` (e.g. already terminal). */
  transition(update: AgentRunTransition): Promise<boolean>;
}

interface AgentRunColumn {
  run_id: string;
  account_id: string | null;
  project_id: string;
  kind: string;
  status: string;
  input_json: unknown;
  result_json: unknown;
  error_json: unknown;
  job_id: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function invalid(where: string, runId?: string): never {
  throw new ApiError(500, 'agent_run_state_invalid', 'Persisted agent run is malformed.', {
    ...(runId ? { runId } : {}),
    where,
  });
}

/** Fail-closed mapping: corrupt persisted state throws rather than being reinterpreted. */
function rowFromColumn(row: AgentRunColumn): AgentRunRow {
  if (!isAgentRunId(row.run_id)) invalid('run_id');
  if (!(AGENT_RUN_KINDS as readonly string[]).includes(row.kind)) invalid('kind', row.run_id);
  if (!(AGENT_RUN_STATUSES as readonly string[]).includes(row.status)) invalid('status', row.run_id);
  if (!isValidAgentRunInput(row.input_json)) invalid('input_json', row.run_id);
  if (row.result_json !== null && row.result_json !== undefined && !isValidDesignerProposal(row.result_json)) {
    invalid('result_json', row.run_id);
  }
  if (row.error_json !== null && row.error_json !== undefined && !isValidAgentRunError(row.error_json)) {
    invalid('error_json', row.run_id);
  }
  return {
    runId: row.run_id,
    accountId: row.account_id,
    projectId: row.project_id,
    kind: row.kind as AgentRunKind,
    status: row.status as AgentRunStatus,
    input: row.input_json,
    result: (row.result_json as DesignerProposal | null) ?? null,
    error: row.error_json as AgentRunError | null,
    jobId: row.job_id,
    userId: row.created_by,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function internalError(where: string, error: { message?: string }): never {
  logger.error({ err: error?.message }, `seo_agent_runs ${where} failed`);
  throw new ApiError(500, 'agent_run_persist_failed', `Agent run ${where} failed.`, {});
}

const SELECT_COLUMNS =
  'run_id,account_id,project_id,kind,status,input_json,result_json,error_json,job_id,idempotency_key,created_by,created_at,updated_at,completed_at';

/** Production repository over the Supabase service-role client. */
export class SupabaseAgentRunRepository implements AgentRunRepository {
  constructor(private readonly sb: ReturnType<typeof createAdminClient>) {}

  async insert(run: NewAgentRun): Promise<void> {
    if (!run.userId) {
      throw new ApiError(500, 'agent_run_persist_failed', 'An agent run cannot be created without a user.', {});
    }
    const { error } = await this.sb
      .from('seo_agent_runs')
      .insert({
        run_id: run.runId,
        account_id: run.accountId,
        project_id: run.projectId,
        kind: run.kind,
        status: run.status,
        input_json: run.input as never,
        job_id: run.jobId ?? null,
        idempotency_key: run.idempotencyKey ?? null,
        created_by: run.userId,
      })
      .select('id');
    if (error) {
      if (String(error.message).toLowerCase().includes('duplicate') || String(error.code).includes('23505')) {
        throw ApiError.conflict('A run with the same idempotency key already exists');
      }
      internalError('create', error);
    }
  }

  async getBound(runId: AgentRunId, projectId: string): Promise<AgentRunRow | null> {
    const { data, error } = await this.sb
      .from('seo_agent_runs')
      .select(SELECT_COLUMNS)
      .eq('run_id', runId)
      .eq('project_id', projectId)
      .maybeSingle();
    if (error) internalError('read', error);
    if (!data) return null;
    return rowFromColumn(data as never);
  }

  async getByProjectAndKey(projectId: string, idempotencyKey: string): Promise<AgentRunRow | null> {
    const { data, error } = await this.sb
      .from('seo_agent_runs')
      .select(SELECT_COLUMNS)
      .eq('project_id', projectId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (error) internalError('read-by-key', error);
    if (!data) return null;
    return rowFromColumn(data as never);
  }

  async setJobId(runId: AgentRunId, projectId: string, jobId: string | null): Promise<void> {
    const { error } = await this.sb
      .from('seo_agent_runs')
      .update({ job_id: jobId })
      .eq('run_id', runId)
      .eq('project_id', projectId);
    if (error) internalError('set-job', error);
  }

  async transition(update: AgentRunTransition): Promise<boolean> {
    const patch: Record<string, unknown> = { status: update.to };
    if (update.result !== undefined) patch.result_json = update.result;
    if (update.error !== undefined) patch.error_json = update.error;
    if (update.completedAt !== undefined) patch.completed_at = update.completedAt;
    const { data, error } = await this.sb
      .from('seo_agent_runs')
      .update(patch as never)
      .eq('run_id', update.runId)
      .eq('project_id', update.projectId)
      .in('status', [...update.from])
      .select('id');
    if (error) internalError('transition', error);
    return (data?.length ?? 0) > 0;
  }
}

/** In-memory repository for tests: same binding + optimistic-transition semantics. */
export class InMemoryAgentRunRepository implements AgentRunRepository {
  private readonly rows = new Map<string, AgentRunRow>();

  private key(runId: AgentRunId, projectId: string): string {
    return `${projectId}:${runId}`;
  }

  async insert(run: NewAgentRun): Promise<void> {
    const key = this.key(run.runId, run.projectId);
    if (this.rows.has(key)) {
      throw ApiError.conflict('A run with the same idempotency key already exists');
    }
    for (const existing of this.rows.values()) {
      if (run.idempotencyKey && existing.projectId === run.projectId && existing.idempotencyKey === run.idempotencyKey) {
        throw ApiError.conflict('A run with the same idempotency key already exists');
      }
    }
    const now = new Date().toISOString();
    this.rows.set(key, {
      runId: run.runId,
      accountId: run.accountId,
      projectId: run.projectId,
      kind: run.kind,
      status: run.status,
      input: run.input,
      result: null,
      error: null,
      jobId: run.jobId ?? null,
      userId: run.userId,
      idempotencyKey: run.idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
  }

  async getBound(runId: AgentRunId, projectId: string): Promise<AgentRunRow | null> {
    const row = this.rows.get(this.key(runId, projectId));
    return row ? { ...row } : null;
  }

  async getByProjectAndKey(projectId: string, idempotencyKey: string): Promise<AgentRunRow | null> {
    for (const row of this.rows.values()) {
      if (row.projectId === projectId && row.idempotencyKey === idempotencyKey) return { ...row };
    }
    return null;
  }

  async setJobId(runId: AgentRunId, projectId: string, jobId: string | null): Promise<void> {
    const key = this.key(runId, projectId);
    const row = this.rows.get(key);
    if (row) this.rows.set(key, { ...row, jobId, updatedAt: new Date().toISOString() });
  }

  async transition(update: AgentRunTransition): Promise<boolean> {
    const key = this.key(update.runId, update.projectId);
    const row = this.rows.get(key);
    if (!row || !update.from.includes(row.status)) return false;
    this.rows.set(key, {
      ...row,
      status: update.to,
      result: update.result !== undefined ? update.result : row.result,
      error: update.error !== undefined ? update.error : row.error,
      updatedAt: new Date().toISOString(),
      completedAt: update.completedAt !== undefined ? update.completedAt : row.completedAt,
    });
    return true;
  }
}
