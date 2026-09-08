/**
 * Durable writer run repository (W7).
 *
 * seo_writer_runs is the safe external source of truth for a run: its row is
 * bound to exactly one projectId + contentId (+ optional account and the user
 * who started it), its status is the safe lifecycle vocabulary and state_json
 * holds only the validated WriterRunSnapshot (see agents/writer/snapshot.ts).
 *
 * The repository is deliberately narrow and binding-aware: every read and every
 * state transition filters on run_id AND project_id AND content_id, so a runId
 * alone is never enough to address a row (project membership authorization on
 * top stays the responsibility of the access service / routes). Transitions are
 * optimistic (`from` is part of the UPDATE), which is what makes approve and
 * recovery concurrency-safe.
 *
 * Two implementations share this contract: a Supabase (service-role) one used
 * in production and an in-memory one used by tests to exercise crash/restart
 * without a database.
 */

import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';
import type { createAdminClient } from '../supabase.js';
import type { WriterRunId } from '../agents/writer/runtime.js';
import {
  parseWriterRunSnapshot,
  type WriterRunSnapshot,
} from '../agents/writer/snapshot.js';

/** Safe external lifecycle vocabulary of seo_writer_runs.status (matches the
 *  table CHECK constraint). */
export const WRITER_RUN_DB_STATUSES = [
  'starting',
  'gathering_context',
  'planning',
  'awaiting_approval',
  'writing',
  'review_ready',
  'completed',
  'rejected',
  'failed',
] as const;
export type WriterRunDbStatus = (typeof WRITER_RUN_DB_STATUSES)[number];

export const WRITER_RUN_TERMINAL_STATUSES: readonly WriterRunDbStatus[] = ['completed', 'rejected', 'failed'];
/** Statuses a process restart may need to do something about. */
export const WRITER_RUN_RECOVERABLE_STATUSES: readonly WriterRunDbStatus[] = [
  'starting',
  'gathering_context',
  'planning',
  'writing',
  'review_ready',
];

/** A run row as the service sees it: binding + safe status + validated
 *  snapshot. Never any checkpoint internals. */
export interface WriterRunRow {
  runId: WriterRunId;
  accountId: string | null;
  projectId: string;
  contentId: string;
  userId: string | null;
  status: WriterRunDbStatus;
  snapshot: WriterRunSnapshot;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Payload to create a new run row. */
export interface NewWriterRun {
  runId: WriterRunId;
  accountId: string | null;
  projectId: string;
  contentId: string;
  userId: string | null;
  status: WriterRunDbStatus;
  snapshot: WriterRunSnapshot;
}

/** A single optimistic status transition, always scoped to the full binding. */
export interface WriterRunTransition {
  runId: WriterRunId;
  projectId: string;
  contentId: string;
  from: readonly WriterRunDbStatus[];
  to: WriterRunDbStatus;
  snapshot: WriterRunSnapshot;
  completedAt: string | null;
}

export interface WriterRunRepository {
  insert(run: NewWriterRun): Promise<void>;
  /** Bound read; null when no row matches the full binding. Snapshot parsing
   *  is fail-closed: corrupt state throws writer_run_state_invalid. */
  getBound(runId: WriterRunId, projectId: string, contentId: string): Promise<WriterRunRow | null>;
  /** Optimistic transition; false when no row was in `from`. */
  transition(update: WriterRunTransition): Promise<boolean>;
  /** All rows currently in the given statuses (recovery scan). */
  listByStatus(statuses: readonly WriterRunDbStatus[]): Promise<WriterRunRow[]>;
}

function rowFromColumn(row: {
  run_id: string;
  account_id: string | null;
  project_id: string;
  content_id: string;
  user_id: string | null;
  status: WriterRunDbStatus;
  state_json: unknown;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}): WriterRunRow {
  if (!WRITER_RUN_DB_STATUSES.includes(row.status)) {
    throw new ApiError(500, 'writer_run_state_invalid', 'Persisted writer run has an unknown status.', {
      runId: row.run_id,
    });
  }
  const snapshot = parseWriterRunSnapshot(row.state_json, { runId: row.run_id, projectId: row.project_id });
  return {
    runId: row.run_id as WriterRunId,
    accountId: row.account_id,
    projectId: row.project_id,
    contentId: row.content_id,
    userId: row.user_id,
    status: row.status,
    snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function internalError(where: string, error: { message?: string }): never {
  logger.error({ err: error?.message }, `seo_writer_runs ${where} failed`);
  throw new ApiError(500, 'writer_run_persist_failed', `Writer run ${where} failed.`, {});
}

/** Production repository over the Supabase service-role client. Every query is
 *  scoped to run_id + project_id + content_id. */
export class SupabaseWriterRunRepository implements WriterRunRepository {
  constructor(private readonly sb: ReturnType<typeof createAdminClient>) {}

  async insert(run: NewWriterRun): Promise<void> {
    if (!run.userId) {
      throw new ApiError(500, 'writer_run_persist_failed', 'A writer run cannot be created without a user.', {});
    }
    const { error } = await this.sb
      .from('seo_writer_runs')
      .insert({
        run_id: run.runId,
        account_id: run.accountId,
        project_id: run.projectId,
        content_id: run.contentId,
        user_id: run.userId,
        status: run.status,
        state_json: JSON.stringify(run.snapshot),
      })
      .select('id');
    if (error) internalError('create', error);
  }

  async getBound(runId: WriterRunId, projectId: string, contentId: string): Promise<WriterRunRow | null> {
    const { data, error } = await this.sb
      .from('seo_writer_runs')
      .select('run_id,account_id,project_id,content_id,user_id,status,state_json,created_at,updated_at,completed_at')
      .eq('run_id', runId)
      .eq('project_id', projectId)
      .eq('content_id', contentId)
      .maybeSingle();
    if (error) internalError('read', error);
    if (!data) return null;
    return rowFromColumn(data as never);
  }

  async transition(update: WriterRunTransition): Promise<boolean> {
    const { data, error } = await this.sb
      .from('seo_writer_runs')
      .update({
        status: update.to,
        state_json: JSON.stringify(update.snapshot),
        completed_at: update.completedAt,
      })
      .eq('run_id', update.runId)
      .eq('project_id', update.projectId)
      .eq('content_id', update.contentId)
      .in('status', [...update.from])
      .select('id');
    if (error) internalError('transition', error);
    return (data?.length ?? 0) > 0;
  }

  async listByStatus(statuses: readonly WriterRunDbStatus[]): Promise<WriterRunRow[]> {
    const { data, error } = await this.sb
      .from('seo_writer_runs')
      .select('run_id,account_id,project_id,content_id,user_id,status,state_json,created_at,updated_at,completed_at')
      .in('status', [...statuses]);
    if (error) internalError('list', error);
    return (data ?? []).map((row) => rowFromColumn(row as never));
  }
}

/** In-memory repository for tests: same binding + optimistic-transition
 *  semantics, no database. */
export class InMemoryWriterRunRepository implements WriterRunRepository {
  private readonly rows = new Map<string, WriterRunRow>();

  private key(runId: WriterRunId, projectId: string, contentId: string): string {
    return `${projectId}:${contentId}:${runId}`;
  }

  async insert(run: NewWriterRun): Promise<void> {
    const now = new Date().toISOString();
    this.rows.set(this.key(run.runId, run.projectId, run.contentId), {
      runId: run.runId,
      accountId: run.accountId,
      projectId: run.projectId,
      contentId: run.contentId,
      userId: run.userId,
      status: run.status,
      snapshot: run.snapshot,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
  }

  async getBound(runId: WriterRunId, projectId: string, contentId: string): Promise<WriterRunRow | null> {
    const row = this.rows.get(this.key(runId, projectId, contentId));
    if (!row) return null;
    // Same fail-closed parse as the database path.
    parseWriterRunSnapshot(row.snapshot, { runId: row.runId, projectId: row.projectId });
    return { ...row, snapshot: row.snapshot };
  }

  async transition(update: WriterRunTransition): Promise<boolean> {
    const key = this.key(update.runId, update.projectId, update.contentId);
    const row = this.rows.get(key);
    if (!row || !update.from.includes(row.status)) return false;
    this.rows.set(key, {
      ...row,
      status: update.to,
      snapshot: update.snapshot,
      updatedAt: new Date().toISOString(),
      completedAt: update.completedAt,
    });
    return true;
  }

  async listByStatus(statuses: readonly WriterRunDbStatus[]): Promise<WriterRunRow[]> {
    return [...this.rows.values()].filter((row) => statuses.includes(row.status)).map((row) => ({ ...row }));
  }
}
