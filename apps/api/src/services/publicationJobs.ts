/**
 * Logical publication identity + idempotent publish-job enqueue (R5.11.2 H3).
 *
 * A publish operation must reach a publisher's remote API at most once per
 * logical operation, while worker retries of the same job stay legitimate
 * physical attempts. The durable job queue already carries a unique
 * `idempotency_key` (seo_sync_jobs_idempotency_unique in
 * 20260101000005_jobs_publishing.sql); this module derives that key from the
 * operation's existing identity so duplicate submissions, concurrent requests
 * and a double click all resolve to one durable job instead of issuing two
 * remote posts.
 *
 * Identity is taken from the publishing model, not invented:
 *   - a lifecycle action (publish/update/delete of an existing publication) is
 *     identified by its publication row, e.g. `publish:action:update:<id>`;
 *   - a direct create is identified by its publish intent (publisher + payload
 *     snapshot), so two identical submissions collapse while a changed or new
 *     document is a genuinely new operation.
 *
 * The identity is suffixed with an attempt generation - the number of jobs
 * already recorded for that identity - so an operation that reached a terminal
 * state (failed/finished) can be deliberately re-run instead of being blocked
 * by the unique key forever. Scheduled publishing keeps its own existing
 * schedule-bound key (see scheduleService) and is untouched.
 */

import { createHash } from 'node:crypto';
import { ApiError } from '../apiErrors.js';
import { rowToRecord } from '../jobs/supabaseJobStore.js';
import type { JobRecord } from '../jobs/types.js';
import type { ServiceContainer } from '../context.js';

export type PublishAction = 'publish' | 'update' | 'delete';

export type PublishJobType = 'publish' | 'publish_update' | 'publish_delete';

const ACTION_JOB_TYPE: Record<PublishAction, PublishJobType> = {
  publish: 'publish',
  update: 'publish_update',
  delete: 'publish_delete',
};

/** Map a lifecycle action onto its executor job type (same vocabulary as before). */
export function publishJobType(action: PublishAction): PublishJobType {
  return ACTION_JOB_TYPE[action];
}

/** A raw seo_sync_jobs row as returned by PostgREST for the identity lookup. */
type JobRow = Record<string, unknown> & { id: string; status: string };

const ACTIVE_STATUSES: readonly string[] = ['queued', 'running'];

function isActive(row: JobRow): boolean {
  return ACTIVE_STATUSES.includes(row.status);
}

/** The payload of a direct (non-scheduled) publication request. */
export interface DirectPublishIntent {
  projectId: string;
  publisherId: string;
  publishKind: string;
  remoteStatus: string;
  contentId?: string | null;
  title: string;
  slug?: string | null;
  content?: string | null;
  excerpt?: string | null;
  scheduledFor?: string | null;
}

/**
 * Canonical content fingerprint of a direct publish intent. Two requests with
 * the same publisher, kind, status and payload snapshot share a fingerprint;
 * any material change produces a new one.
 */
function contentFingerprint(intent: DirectPublishIntent): string {
  const canonical = JSON.stringify([
    intent.contentId ?? null,
    intent.title,
    intent.slug ?? null,
    intent.content ?? null,
    intent.excerpt ?? null,
    intent.scheduledFor ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Logical identity of a direct (composer) publication operation. */
export function directPublishIdentity(intent: DirectPublishIntent): string {
  return [
    'publish:create',
    intent.projectId,
    intent.publisherId,
    intent.publishKind,
    intent.remoteStatus,
    contentFingerprint(intent),
  ].join(':');
}

/** Logical identity of a lifecycle action against an existing publication row. */
export function actionPublishIdentity(publicationId: string, action: PublishAction): string {
  return ['publish:action', action, publicationId].join(':');
}

/** Deterministic key for one attempt of a logical publish operation. */
export function publishJobIdempotencyKey(identity: string, generation: number): string {
  return `${identity}:${generation}`;
}

/**
 * Every job already recorded for one logical publish identity, newest first.
 * The identity is embedded in the idempotency key, so a LIKE-prefix query reads
 * exactly this operation's attempts without scanning the whole queue. Identities
 * are built from uuids/tokens/hex only, so the pattern carries no LIKE wildcard.
 */
export async function publicationJobsByIdentity(
  container: ServiceContainer,
  projectId: string,
  identity: string,
): Promise<JobRow[]> {
  const { data, error } = await container.sb
    .from('seo_sync_jobs')
    .select('*')
    .eq('project_id', projectId)
    .like('idempotency_key', `${identity}:%`)
    .order('created_at', { ascending: false });
  if (error) throw ApiError.badRequest('Could not read publish jobs for this publication');
  return (data ?? []) as JobRow[];
}

/**
 * The in-flight job for a logical operation, if one exists. Lets a route reuse
 * an existing submission's publication+job without creating a duplicate row;
 * enqueuePublicationJob re-checks under the unique key to close the race.
 */
export async function reusablePublicationJob(
  container: ServiceContainer,
  projectId: string,
  identity: string,
): Promise<JobRecord | null> {
  const rows = await publicationJobsByIdentity(container, projectId, identity);
  const active = rows.find(isActive);
  return active ? rowToRecord(active) : null;
}

export interface EnqueuePublicationJobArgs {
  projectId: string;
  userId: string;
  identity: string;
  provider: string;
  jobType: PublishJobType;
  params: Record<string, unknown>;
  runAfter?: string;
}

export interface EnqueuePublicationJobResult {
  job: JobRecord;
  /** True when an existing logical operation was reused instead of creating a job. */
  reused: boolean;
}

/**
 * Enqueue one publish job for a logical operation, collapsing duplicates.
 *
 * Repeat-before-completion is handled by reusing a still queued/running job for
 * the same identity (reads durable state, so it holds across tabs, API instances
 * and worker restarts). A concurrent duplicate that slipped past the reuse check
 * races on the unique idempotency key; the loser re-reads and reuses the winner
 * instead of creating a second job. Only a new logical operation - or one whose
 * previous attempt is terminal - gets a fresh generation.
 */
export async function enqueuePublicationJob(
  container: ServiceContainer,
  args: EnqueuePublicationJobArgs,
): Promise<EnqueuePublicationJobResult> {
  const existing = await publicationJobsByIdentity(container, args.projectId, args.identity);
  const active = existing.find(isActive);
  if (active) return { job: rowToRecord(active), reused: true };

  const key = publishJobIdempotencyKey(args.identity, existing.length);
  try {
    const job = await container.jobStore.enqueue({
      project_id: args.projectId,
      provider: args.provider,
      job_type: args.jobType,
      params: args.params,
      created_by: args.userId,
      run_after: args.runAfter,
      idempotency_key: key,
    });
    return { job, reused: false };
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'conflict') throw err;
    const raced = await publicationJobsByIdentity(container, args.projectId, args.identity);
    const winner = raced.find(isActive) ?? raced[0];
    if (winner) return { job: rowToRecord(winner), reused: true };
    throw err;
  }
}
