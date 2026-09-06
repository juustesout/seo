/**
 * Content scheduling application service (Content Studio Phase H1).
 *
 * A schedule is a *planning* row (seo_schedules). Execution is delegated to the
 * existing job infrastructure: creating a schedule enqueues exactly one
 * `publish` job whose run_after equals scheduled_at and whose deterministic
 * idempotency key is bound to the schedule id. The same job is mutated on
 * reschedule (never duplicated) and canceled on cancel. seo_publications rows
 * carry the payload the executor needs and link back via schedule_id; their
 * existing publishing behavior is untouched.
 *
 * seo_schedules.status is a read model synchronized from job/publication
 * outcomes (see syncScheduleStatus, called by the worker) - it is never a
 * second source of truth and never drives execution.
 */

import { randomUUID } from 'node:crypto';
import type { CreateScheduleInput, ScheduleDto, ScheduleStatus } from '@seo/contracts';
import { asTipDoc, renderDocHtml } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';
import type { ServiceContainer } from '../context.js';

type Row = Record<string, unknown>;

export const SCHEDULE_STATUSES = [
  'scheduled',
  'queued',
  'publishing',
  'published',
  'failed',
  'cancelled',
] as const;

/** States from which a future schedule can be moved to a new time. */
const RESCHEDULABLE = ['scheduled'] as const;
/** States from which a schedule can still be cancelled (not actively publishing). */
const CANCELLABLE = ['scheduled', 'queued'] as const;

const SCHEDULE_COLUMNS =
  'id, project_id, content_id, publisher_id, scheduled_at, status, job_id, created_by, created_at, updated_at, cancelled_at';

/** Deterministic, schedule-bound job idempotency key (see seo_sync_jobs). */
export function scheduleIdempotencyKey(scheduleId: string): string {
  return `schedule:${scheduleId}:publish`;
}

function parseFutureIso(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (ms <= Date.now()) return null;
  return new Date(ms).toISOString();
}

function iso(value: unknown): string {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value ?? '');
}

/** Best-effort HTML render of a content row (seo_content_html is authoritative). */
function contentHtmlOf(content: Row): string {
  const stored = content.content_html;
  if (typeof stored === 'string') return stored;
  const json = content.content_json;
  if (json == null) return '';
  try {
    return renderDocHtml(asTipDoc(json as never));
  } catch {
    return '';
  }
}

export class ScheduleService {
  constructor(private readonly container: ServiceContainer) {}

  private get sb() {
    return this.container.sb;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(projectId: string): Promise<ScheduleDto[]> {
    const { data, error } = await this.sb
      .from('seo_schedules')
      .select(SCHEDULE_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      logger.error({ error }, 'schedule list failed');
      throw ApiError.badRequest('Could not list schedules');
    }
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) return [];
    return this.enrich(projectId, rows);
  }

  /** Resolve one schedule row to its DTO (content title + publisher name). */
  async get(projectId: string, scheduleId: string): Promise<ScheduleDto> {
    const row = await this.requireSchedule(projectId, scheduleId);
    const [dto] = await this.enrich(projectId, [row]);
    return dto;
  }

  // -------------------------------------------------------------------------
  // Write path
  // -------------------------------------------------------------------------

  /**
   * Validate + create a schedule. One publish job is enqueued per schedule with
   * run_after = scheduled_at and a schedule-bound idempotency key, so retries
   * or a duplicate request can never create a second job for the same schedule.
   */
  async create(projectId: string, userId: string, input: CreateScheduleInput): Promise<ScheduleDto> {
    const scheduledAt = parseFutureIso(input.scheduled_at);
    if (!scheduledAt) {
      throw new ApiError(400, 'invalid_schedule_time', 'scheduled_at must be a valid ISO timestamp in the future');
    }

    const content = await this.requireContent(projectId, input.content_id);
    const publisher = await this.requirePublisher(projectId, input.publisher_id);

    const scheduleId = randomUUID();
    const now = new Date().toISOString();
    const scheduleRow: Row = {
      id: scheduleId,
      project_id: projectId,
      content_id: input.content_id,
      publisher_id: input.publisher_id,
      scheduled_at: scheduledAt,
      status: 'scheduled',
      job_id: null,
      created_by: userId,
    };

    const { data: inserted, error: insertError } = await this.sb
      .from('seo_schedules')
      .insert(scheduleRow as never)
      .select()
      .single();
    if (insertError || !inserted) {
      throw ApiError.badRequest(`Could not create schedule: ${insertError?.message ?? 'insert returned no row'}`);
    }
    const row = inserted as Row;

    // Everything from here can be rolled back by cancelling the schedule (we
    // never delete rows). If the job is created but linking fails, the schedule
    // is cancelled and the job is cancelled too so nothing can run later.
    let jobId: string | null = null;
    try {
      const { data: publication, error: pubError } = await this.sb
        .from('seo_publications')
        .insert({
          project_id: projectId,
          publisher_id: input.publisher_id,
          content_id: input.content_id,
          schedule_id: scheduleId,
          status: 'scheduled',
          title: String(content.title ?? 'Untitled'),
          slug: content.slug ? String(content.slug) : null,
          content: contentHtmlOf(content),
          excerpt: content.excerpt ? String(content.excerpt) : content.meta_description ? String(content.meta_description) : null,
          scheduled_for: scheduledAt,
          created_by: userId,
        } as never)
        .select()
        .single();
      if (pubError || !publication) {
        throw ApiError.badRequest(`Could not prepare the publication: ${pubError?.message ?? 'insert returned no row'}`);
      }

      const job = await this.container.jobStore.enqueue({
        project_id: projectId,
        provider: String(publisher.provider),
        job_type: 'publish',
        params: {
          publication_id: (publication as Row).id,
          remote_status: 'publish',
          schedule_id: scheduleId,
        },
        created_by: userId,
        run_after: scheduledAt,
        idempotency_key: scheduleIdempotencyKey(scheduleId),
      });
      jobId = job.id;

      const linked = await this.linkJob(projectId, scheduleId, job.id);
      if (!linked) {
        // Cancelled (or started) concurrently between the enqueue and the link;
        // never let the orphan job run.
        await this.container.jobStore.cancel(job.id).catch(() => undefined);
        throw new ApiError(409, 'schedule_not_editable', 'The schedule changed while it was being created');
      }
    } catch (err) {
      await this.markCancelled(projectId, scheduleId).catch(() => undefined);
      if (jobId) await this.container.jobStore.cancel(jobId).catch(() => undefined);
      throw err;
    }

    return this.toDto(row, content, publisher, jobId);
  }

  /**
   * Move a future schedule to a new time by mutating the backing job's
   * run_after. Preserves the schedule identity and its idempotency key; never
   * enqueues a second job.
   */
  async reschedule(projectId: string, scheduleId: string, scheduledAtValue: string): Promise<ScheduleDto> {
    const scheduledAt = parseFutureIso(scheduledAtValue);
    if (!scheduledAt) {
      throw new ApiError(400, 'invalid_schedule_time', 'scheduled_at must be a valid ISO timestamp in the future');
    }

    const row = await this.requireSchedule(projectId, scheduleId);
    if (row.status !== 'scheduled') {
      throw new ApiError(409, 'schedule_not_editable', `A schedule in status '${String(row.status)}' cannot be rescheduled`);
    }
    const jobId = row.job_id ? String(row.job_id) : null;
    if (!jobId) {
      throw new ApiError(409, 'schedule_not_editable', 'This schedule has no backing job and cannot be rescheduled');
    }

    const previous = iso(row.scheduled_at);
    const moved = await this.container.jobStore.reschedule(jobId, scheduledAt);
    if (!moved) {
      throw new ApiError(409, 'schedule_not_editable', 'The schedule can no longer be rescheduled because its job has already started');
    }

    const { data, error } = await this.sb
      .from('seo_schedules')
      .update({ scheduled_at: scheduledAt })
      .eq('project_id', projectId)
      .eq('id', scheduleId)
      .eq('status', 'scheduled')
      .select('id');
    if (error) {
      await this.container.jobStore.reschedule(jobId, previous).catch(() => undefined);
      throw ApiError.badRequest('Could not reschedule the schedule');
    }
    if (!data || data.length === 0) {
      // Concurrently cancelled or started; put the job back where it was.
      await this.container.jobStore.reschedule(jobId, previous).catch(() => undefined);
      throw new ApiError(409, 'schedule_not_editable', 'The schedule changed while it was being rescheduled');
    }

    const content = await this.requireContent(projectId, String(row.content_id));
    const publisher = await this.requirePublisher(projectId, String(row.publisher_id));
    return this.toDto({ ...row, scheduled_at: scheduledAt, updated_at: new Date().toISOString() }, content, publisher, jobId);
  }

  /**
   * Cancel a schedule. Idempotent: cancelling an already-cancelled schedule is
   * a no-op success. Only allowed while the schedule has not started
   * publishing; the atomic status gate prevents racing with the worker.
   */
  async cancel(projectId: string, scheduleId: string): Promise<ScheduleDto> {
    const { data, error } = await this.sb
      .from('seo_schedules')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('id', scheduleId)
      .in('status', [...CANCELLABLE])
      .select('id, job_id');
    if (error) {
      logger.error({ error }, 'schedule cancel update failed');
      throw ApiError.badRequest('Could not cancel the schedule');
    }

    const cancelled = (data ?? []) as Row[];
    if (cancelled.length > 0) {
      const jobId = cancelled[0].job_id ? String(cancelled[0].job_id) : null;
      if (jobId) {
        await this.container.jobStore.cancel(jobId).catch((err) =>
          logger.warn({ err, jobId }, 'could not cancel backing job for schedule'),
        );
      }
      return this.get(projectId, scheduleId);
    }

    // Gate matched nothing: distinguish already-cancelled (idempotent success)
    // from terminal states that are not cancellable.
    const existing = await this.requireSchedule(projectId, scheduleId);
    if (existing.status === 'cancelled') return this.get(projectId, scheduleId);
    throw new ApiError(
      409,
      'schedule_not_cancellable',
      `A schedule in status '${String(existing.status)}' cannot be cancelled`,
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async requireSchedule(projectId: string, scheduleId: string): Promise<Row> {
    const { data, error } = await this.sb
      .from('seo_schedules')
      .select(SCHEDULE_COLUMNS)
      .eq('project_id', projectId)
      .eq('id', scheduleId)
      .maybeSingle();
    if (error || !data) throw new ApiError(404, 'schedule_not_found', 'Schedule not found in this project');
    return data as Row;
  }

  private async requireContent(projectId: string, contentId: string): Promise<Row> {
    const { data, error } = await this.sb
      .from('seo_content')
      .select('id, title, slug, excerpt, meta_description, content_json, content_html')
      .eq('project_id', projectId)
      .eq('id', contentId)
      .maybeSingle();
    if (error || !data) throw new ApiError(404, 'content_not_found', 'Content not found in this project');
    return data as Row;
  }

  private async requirePublisher(projectId: string, publisherId: string): Promise<Row> {
    const { data, error } = await this.sb
      .from('seo_publishers')
      .select('id, name, provider, status')
      .eq('project_id', projectId)
      .eq('id', publisherId)
      .maybeSingle();
    if (error || !data) throw new ApiError(404, 'publisher_not_found', 'Publisher not found in this project');
    const publisher = data as Row;
    if (publisher.status !== 'connected') {
      throw new ApiError(
        400,
        'publisher_not_available',
        `Publisher '${String(publisher.name)}' is not connected. Test the connection first.`,
      );
    }
    return publisher;
  }

  private async linkJob(projectId: string, scheduleId: string, jobId: string): Promise<boolean> {
    const { data, error } = await this.sb
      .from('seo_schedules')
      .update({ job_id: jobId })
      .eq('project_id', projectId)
      .eq('id', scheduleId)
      .eq('status', 'scheduled')
      .is('job_id', null)
      .select('id');
    if (error) {
      logger.error({ error }, 'schedule job link failed');
      return false;
    }
    return (data ?? []).length > 0;
  }

  private async markCancelled(projectId: string, scheduleId: string): Promise<void> {
    await this.sb
      .from('seo_schedules')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('id', scheduleId)
      .in('status', [...CANCELLABLE]);
  }

  /** Attach content title + publisher name (list + get use batched lookups). */
  private async enrich(projectId: string, rows: Row[]): Promise<ScheduleDto[]> {
    const contentIds = new Set<string>();
    const publisherIds = new Set<string>();
    for (const r of rows) {
      if (typeof r.content_id === 'string') contentIds.add(r.content_id);
      if (typeof r.publisher_id === 'string') publisherIds.add(r.publisher_id);
    }
    const [contentRows, publisherRows] = await Promise.all([
      this.sb
        .from('seo_content')
        .select('id, title')
        .eq('project_id', projectId)
        .in('id', [...contentIds]),
      this.sb
        .from('seo_publishers')
        .select('id, name')
        .eq('project_id', projectId)
        .in('id', [...publisherIds]),
    ]);
    const titles = new Map<string, string>();
    for (const c of (contentRows.data ?? []) as Row[]) titles.set(String(c.id), String(c.title ?? ''));
    const names = new Map<string, string>();
    for (const p of (publisherRows.data ?? []) as Row[]) names.set(String(p.id), String(p.name ?? ''));

    return rows.map((r) =>
      this.toDto(r, { title: titles.get(String(r.content_id)) ?? null }, { name: names.get(String(r.publisher_id)) ?? null }, r.job_id ? String(r.job_id) : null),
    );
  }

  private toDto(row: Row, content: { title?: string | null }, publisher: { name?: string | null }, jobId: string | null): ScheduleDto {
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      content_id: String(row.content_id),
      content_title: content.title ?? null,
      publisher_id: String(row.publisher_id),
      publisher_name: publisher.name ?? null,
      scheduled_at: iso(row.scheduled_at),
      status: (row.status as ScheduleStatus) ?? 'scheduled',
      job_id: jobId,
      created_by: row.created_by ? String(row.created_by) : null,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      cancelled_at: row.cancelled_at ? iso(row.cancelled_at) : null,
    };
  }
}

/**
 * Synchronize the planning read-model from a job outcome. Safe to call from
 * the worker on every publish job transition for jobs that carry a schedule_id
 * in params; never throws (a sync failure must not fail the job itself).
 */
export async function syncScheduleStatus(
  container: ServiceContainer,
  args: { projectId: string; scheduleId: string; status: ScheduleStatus },
): Promise<void> {
  try {
    const { error } = await container.sb
      .from('seo_schedules')
      .update({ status: args.status })
      .eq('project_id', args.projectId)
      .eq('id', args.scheduleId)
      .in('status', ['scheduled', 'queued', 'publishing']);
    if (error) logger.error({ error, ...args }, 'schedule status sync failed');
  } catch (err) {
    logger.error({ err, ...args }, 'schedule status sync threw');
  }
}
