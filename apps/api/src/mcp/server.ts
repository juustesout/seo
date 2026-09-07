/**
 * SEO MCP server.
 *
 * Exposes the same SEO Core services (ContentService, ContentAnalysisService,
 * ScheduleService, PublicationService) that REST and the UI use. Invariants:
 *  - Identity comes from an API key bound at startup / session open
 *    (MCP_API_KEY env or the HTTP Authorization header). A project key can
 *    only ever reach its own project. An account (master) key can reach every
 *    project its owning user is a member of - resolved + authorized per tool
 *    call, never stronger than that membership (reads need viewer, writes
 *    need editor).
 *  - Read tools require the key's "read" scope; write tools require "write"
 *    (this mirrors the effective project role: viewers read schedules and
 *    publications, editors and above manage them).
 *  - Destructive/state transitions demand an explicit confirmation argument.
 *    Deletion is intentionally not exposed (cancelling a schedule preserves
 *    its history, never deletes the row).
 *  - Long operations enqueue durable jobs and return a job id to poll.
 *  - Scheduling/publishing tools call the shared services; no MCP tool talks
 *    to Postgres or enqueues jobs directly.
 *  - Tool schemas are versioned in each description (schema vN).
 */

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobStore } from '../jobs/types.js';
import type { ServiceContainer } from '../context.js';
import { ContentService } from '../services/contentService.js';
import { ContentAnalysisService } from '../services/contentAnalysisService.js';
import { ScheduleService, SCHEDULE_STATUSES } from '../services/scheduleService.js';
import { PublicationService, PUBLICATION_STATUSES } from '../services/publicationService.js';
import { ApiError } from '../apiErrors.js';
import { AccessService } from '../supabase.js';

const asContainer = (sb: SupabaseClient): ServiceContainer => ({ sb } as unknown as ServiceContainer);

/** Container carrying the job store for services that enqueue work (schedules). */
const fullContainer = (deps: MpcDeps): ServiceContainer =>
  ({ sb: deps.sb, jobStore: deps.jobStore }) as unknown as ServiceContainer;

export interface MpcDeps {
  sb: SupabaseClient;
  jobStore: JobStore;
  /**
   * 'project' keys are bound to one project (projectId is set). 'account'
   * (master) keys are bound to their owning user and resolve the target
   * project per tool call via access.
   */
  scope: 'project' | 'account';
  /** Project the bound project key belongs to; null for account keys. */
  projectId: string | null;
  /** User id recorded on writes (the key creator when known). */
  userId: string | null;
  canRead: boolean;
  canWrite: boolean;
  /** Membership authorization, present for account-key sessions. */
  access?: AccessService;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (deps: MpcDeps, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

function requireRead(deps: MpcDeps): void {
  if (!deps.canRead) throw new ApiError(403, 'forbidden', 'The bound API key lacks the read scope');
}

function requireWrite(deps: MpcDeps): void {
  if (!deps.canWrite) throw new ApiError(403, 'forbidden', 'The bound API key lacks the write scope');
}

/**
 * Resolve + authorize the project a tool call targets.
 *
 * Project keys: the project is the bound one; an explicit project_id (tools
 * that accept one) must match it, any other id is refused so a client can
 * never address another project.
 *
 * Account (master) keys: the caller must pass a project_id and the key's
 * owner must be a member of that project. Reads need at least the viewer role,
 * writes the editor role - a master key therefore never exceeds the owner's
 * membership in the target project, and the owner identity is enforced on
 * every call rather than baked into the key.
 */
async function resolveProjectId(deps: MpcDeps, args: Record<string, unknown>, mode: 'read' | 'write'): Promise<string> {
  const explicit = typeof args.project_id === 'string' && args.project_id.length > 0 ? args.project_id : null;
  const accountKey = deps.scope === 'account' || deps.projectId === null;
  if (!accountKey) {
    const bound = deps.projectId as string;
    if (explicit && explicit !== bound) {
      throw new ApiError(403, 'forbidden', 'project_id does not match the project this API key is bound to');
    }
    return bound;
  }
  if (!explicit) {
    throw new ApiError(400, 'invalid_input', 'project_id is required when using an account API key');
  }
  if (!deps.userId) {
    throw new ApiError(403, 'forbidden', 'No user identity is bound to this account API key');
  }
  if (!deps.access) {
    throw new ApiError(500, 'storage_error', 'Membership authorization is unavailable for this session');
  }
  await deps.access.requireRole(deps.userId, explicit, mode === 'write' ? 'editor' : 'viewer');
  return explicit;
}

// ISO-8601 datetime with a mandatory timezone offset (Z or +hh:mm / -hh:mm).
// "2026-09-10 09:00" and other zone-less forms are rejected here.
const OFFSET_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function requireOffsetIso(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !OFFSET_ISO_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ApiError(
      400,
      'invalid_datetime',
      `${field} must be an ISO-8601 datetime with a timezone offset (e.g. 2026-09-10T09:00:00+02:00 or 2026-09-10T09:00:00Z)`,
    );
  }
  return value;
}

function requireOffsetIsoValue(value: unknown, field: string): string {
  const out = requireOffsetIso(value, field);
  if (out === undefined) throw new ApiError(400, 'invalid_datetime', `${field} is required`);
  return out;
}

function strArg(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function intArg(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function enumArg<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  const s = strArg(value) as T | undefined;
  if (s !== undefined && !(allowed as readonly string[]).includes(s)) {
    throw new ApiError(400, 'invalid_input', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return s;
}

function okText(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export function buildTools(): ToolDef[] {
  const tools: ToolDef[] = [];

  tools.push({
    name: 'project_list',
    title: 'List accessible projects',
    description:
      'Discover the projects this API key can reach before calling any project-scoped tool (schema v1, read). A project key returns its single bound project; an account/master key returns every project you are a member of with your role there. Use the returned project id as the project_id argument of the other tools.',
    readOnly: true,
    inputSchema: {},
    handler: async (deps, _args) => {
      requireRead(deps);
      const access = deps.access ?? new AccessService(deps.sb);
      if (deps.scope === 'account') {
        if (!deps.userId) {
          throw new ApiError(403, 'forbidden', 'No user identity is bound to this account API key');
        }
        const projects = await access.listMembershipProjects(deps.userId);
        return { data: { projects } };
      }
      const bound = deps.projectId as string;
      const info = await access.projectInfo(bound);
      return { data: { projects: info ? [info] : [] } };
    },
  });

  tools.push({
    name: 'content_list',
    title: 'List content',
    description:
      'List project content items (schema v1, read). For account/master keys project_id is required and must be a project you are a member of - call project_list first to discover project ids.',
    readOnly: true,
    inputSchema: {
      project_id: z.string().uuid().optional().describe('Project to operate on (required for account keys; must match the bound project otherwise)'),
      status: z.enum(['draft', 'in_review', 'published', 'archived']).optional().describe('Filter by status'),
      search: z.string().max(200).optional().describe('Substring match on title'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows'),
    },
    handler: async (deps, args) => {
      requireRead(deps);
      const projectId = await resolveProjectId(deps, args, 'read');
      const svc = new ContentService(deps.sb);
      const result = await svc.list(projectId, {
        status: strArg(args.status),
        search: strArg(args.search),
        limit: intArg(args.limit, 200, 1, 200),
      });
      return { data: result };
    },
  });

  tools.push({
    name: 'content_get',
    title: 'Get content',
    description:
      'Fetch a content item with its structured blocks and rendered HTML (schema v1, read). For account/master keys project_id is required and must be a project you are a member of.',
    readOnly: true,
    inputSchema: {
      project_id: z.string().uuid().optional().describe('Project to operate on (required for account keys; must match the bound project otherwise)'),
      id: z.string().uuid().describe('Content id'),
    },
    handler: async (deps, args) => {
      requireRead(deps);
      const projectId = await resolveProjectId(deps, args, 'read');
      const svc = new ContentService(deps.sb);
      return { data: await svc.get(projectId, String(args.id)) };
    },
  });

  tools.push({
    name: 'content_analyze',
    title: 'Analyze content',
    description:
      'Deterministic SEO audit (score/issues/warnings/recommendations) of one content item (schema v1, read, no persistence). For account/master keys project_id is required and must be a project you are a member of.',
    readOnly: true,
    inputSchema: {
      project_id: z.string().uuid().optional().describe('Project to operate on (required for account keys; must match the bound project otherwise)'),
      id: z.string().uuid().describe('Content id'),
    },
    handler: async (deps, args) => {
      requireRead(deps);
      const projectId = await resolveProjectId(deps, args, 'read');
      const svc = new ContentAnalysisService(asContainer(deps.sb));
      return { data: await svc.analyze(projectId, String(args.id)) };
    },
  });

  tools.push({
    name: 'jobs_list',
    title: 'List jobs',
    description:
      'List recent project jobs so async results can be polled (schema v1, read). For account/master keys project_id is required and must be a project you are a member of.',
    readOnly: true,
    inputSchema: {
      project_id: z.string().uuid().optional().describe('Project to operate on (required for account keys; must match the bound project otherwise)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max rows'),
    },
    handler: async (deps, args) => {
      requireRead(deps);
      const projectId = await resolveProjectId(deps, args, 'read');
      const limit = intArg(args.limit, 50, 1, 100);
      return { data: await deps.jobStore.list(projectId, limit) };
    },
  });

  // ---------------------------------------------------------------------------
  // Content generation / editing (write)
  // ---------------------------------------------------------------------------

  tools.push({
    name: 'content_generate',
    title: 'Generate content draft',
    description:
      'Run the staged content agent (brief/outline/article) as a durable job and return the job id (schema v1, write). Poll jobs_list. For account/master keys project_id is required and must be a project you are a member of with editor access.',
    readOnly: false,
    inputSchema: {
      project_id: z.string().uuid().optional().describe('Project to operate on (required for account keys; must match the bound project otherwise)'),
      topic: z.string().min(3).max(500).describe('Article topic'),
      target_keyword: z.string().max(200).optional(),
      language: z.string().max(16).optional().describe('ISO language code'),
      content_length: z.enum(['short', 'medium', 'long']).optional(),
      include_knowledge: z.boolean().optional().describe('Use project knowledge base as context'),
      image_hint: z.string().max(200).nullable().optional().describe('Subject for placeholder images'),
      image_count: z.number().int().min(1).max(4).optional(),
    },
    handler: async (deps, args) => {
      requireWrite(deps);
      const projectId = await resolveProjectId(deps, args, 'write');
      const job = await deps.jobStore.enqueue({
        project_id: projectId,
        provider: 'content',
        job_type: 'content_generate',
        params: {
          topic: args.topic,
          target_keyword: args.target_keyword ?? undefined,
          language: args.language ?? undefined,
          content_length: args.content_length ?? undefined,
          include_knowledge: args.include_knowledge !== false,
          image_hint: args.image_hint ?? null,
          image_count: args.image_count ?? undefined,
        },
        created_by: deps.userId,
      });
      return { data: { job, note: 'Job queued - poll jobs_list for progress.' } };
    },
  });

  tools.push({
    name: 'content_resolve_images',
    title: 'Resolve media placeholders',
    description:
      'Fill media placeholders of a draft with real images via a media provider (schema v1, write). Poll jobs_list. For account/master keys project_id is required and must be a project you are a member of with editor access.',
    readOnly: false,
    inputSchema: {
      project_id: z.string().uuid().optional().describe('Project to operate on (required for account keys; must match the bound project otherwise)'),
      id: z.string().uuid().describe('Content id'),
      image_provider: z.enum(['unsplash', 'openai_media']).default('unsplash'),
      limit: z.number().int().min(1).max(6).optional(),
    },
    handler: async (deps, args) => {
      requireWrite(deps);
      const projectId = await resolveProjectId(deps, args, 'write');
      const job = await deps.jobStore.enqueue({
        project_id: projectId,
        provider: 'content',
        job_type: 'content_images',
        params: { content_id: args.id, image_provider: args.image_provider, limit: intArg(args.limit, 3, 1, 6) },
        created_by: deps.userId,
      });
      return { data: { job, note: 'Job queued - poll jobs_list for progress.' } };
    },
  });

  tools.push({
    name: 'content_update',
    title: 'Update content',
    description:
      'Update content metadata, blocks or status (schema v1, write). Publishing/archiving requires confirm=true. For account/master keys project_id is required and must be a project you are a member of with editor access.',
    readOnly: false,
    inputSchema: {
      project_id: z.string().uuid().optional().describe('Project to operate on (required for account keys; must match the bound project otherwise)'),
      id: z.string().uuid().describe('Content id'),
      title: z.string().max(300).optional(),
      target_keyword: z.string().max(200).nullable().optional(),
      meta_title: z.string().max(300).nullable().optional(),
      meta_description: z.string().max(1000).nullable().optional(),
      excerpt: z.string().max(2000).nullable().optional(),
      status: z.enum(['draft', 'in_review', 'published', 'archived']).optional(),
      confirm: z.boolean().optional().describe('Must be true when changing status to published or archived'),
    },
    handler: async (deps, args) => {
      requireWrite(deps);
      const projectId = await resolveProjectId(deps, args, 'write');
      const status = args.status as string | undefined;
      if ((status === 'published' || status === 'archived') && args.confirm !== true) {
        throw new ApiError(400, 'confirmation_required', 'Set confirm=true to publish or archive content');
      }
      const str = (v: unknown): string | null | undefined => (typeof v === 'string' || v === null || v === undefined ? v : undefined);
      const svc = new ContentService(deps.sb);
      const row = await svc.update(projectId, deps.userId, String(args.id), {
        title: str(args.title) ?? undefined,
        targetKeyword: str(args.target_keyword),
        metaTitle: str(args.meta_title),
        metaDescription: str(args.meta_description),
        excerpt: str(args.excerpt),
        status: (status as never) ?? undefined,
      });
      return { data: row };
    },
  });

  // ---------------------------------------------------------------------------
  // Scheduling (read + write over ScheduleService)
  // ---------------------------------------------------------------------------

  tools.push({
    name: 'schedule_list',
    title: 'List schedules',
    description:
      'List publication schedules for a project. Read-only: inspect what is planned, queued, publishing, published, failed or cancelled. Optionally filter by status or a from/to window on scheduled_at. Times are ISO-8601 with a timezone offset (schema v1, read). For account/master keys project_id must be a project you are a member of.',
    readOnly: true,
    inputSchema: {
      project_id: z.string().uuid().describe('Project to operate on (the one this API key is bound to, or any project you are a member of for account keys)'),
      status: z.enum(SCHEDULE_STATUSES).optional().describe('Filter by schedule status'),
      from: z.string().optional().describe('Only schedules at or after this ISO datetime (inclusive)'),
      to: z.string().optional().describe('Only schedules at or before this ISO datetime (inclusive)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows'),
    },
    handler: async (deps, args) => {
      requireRead(deps);
      const projectId = await resolveProjectId(deps, args, 'read');
      const svc = new ScheduleService(fullContainer(deps));
      const data = await svc.list(projectId, {
        status: enumArg(args.status, SCHEDULE_STATUSES, 'status'),
        from: requireOffsetIso(args.from, 'from'),
        to: requireOffsetIso(args.to, 'to'),
        limit: intArg(args.limit, 50, 1, 200),
      });
      return { data };
    },
  });

  tools.push({
    name: 'schedule_create',
    title: 'Create a publication schedule',
    description:
      'Schedule an existing content item for publication through a connected publisher. The publication executes at scheduled_at (ISO-8601 with timezone offset, must be in the future). publish_kind declares the publication intent and must be supported by the publisher: article requires publish_article (e.g. WordPress), text requires publish_text (e.g. X), image/video their exact capabilities. It defaults to article. This creates a schedule, prepares the publication, and enqueues a single durable job - one schedule maps to one backing job (schema v1, write).',
    readOnly: false,
    inputSchema: {
      project_id: z.string().uuid().describe('Project to operate on (the one this API key is bound to, or any project you are a member of for account keys)'),
      content_id: z.string().uuid().describe('Content item to publish'),
      publisher_id: z.string().uuid().describe('Connected publisher to publish through'),
      publish_kind: z.enum(['article', 'text', 'image', 'video']).default('article').describe('Publication intent (default article)'),
      scheduled_at: z.string().describe('When to publish (ISO-8601 datetime with timezone offset, e.g. 2026-09-10T09:00:00+02:00)'),
    },
    handler: async (deps, args) => {
      requireWrite(deps);
      const projectId = await resolveProjectId(deps, args, 'write');
      const userId = deps.userId;
      if (!userId) {
        throw new ApiError(403, 'forbidden', 'No user identity is bound to this API key; cannot create schedules');
      }
      const contentId = requireUuid(args.content_id, 'content_id');
      const publisherId = requireUuid(args.publisher_id, 'publisher_id');
      const publishKind = enumArg(args.publish_kind, ['article', 'text', 'image', 'video'] as const, 'publish_kind');
      const scheduledAt = requireOffsetIsoValue(args.scheduled_at, 'scheduled_at');
      const svc = new ScheduleService(fullContainer(deps));
      return {
        data: await svc.create(projectId, userId, {
          content_id: contentId,
          publisher_id: publisherId,
          publish_kind: publishKind ?? 'article',
          scheduled_at: scheduledAt,
        }),
      };
    },
  });

  tools.push({
    name: 'schedule_reschedule',
    title: 'Move a pending schedule to a new time',
    description:
      'Move a not-yet-started schedule to a new scheduled_at (ISO-8601 with timezone offset, must be in the future). The existing backing job is moved to the new time - it is never cancelled and no second job is created (schema v1, write).',
    readOnly: false,
    inputSchema: {
      project_id: z.string().uuid().describe('Project to operate on (the one this API key is bound to, or any project you are a member of for account keys)'),
      schedule_id: z.string().uuid().describe('Schedule to move'),
      scheduled_at: z.string().describe('New publish time (ISO-8601 datetime with timezone offset, e.g. 2026-09-10T09:00:00+02:00)'),
    },
    handler: async (deps, args) => {
      requireWrite(deps);
      const projectId = await resolveProjectId(deps, args, 'write');
      const scheduleId = requireUuid(args.schedule_id, 'schedule_id');
      const scheduledAt = requireOffsetIsoValue(args.scheduled_at, 'scheduled_at');
      const svc = new ScheduleService(fullContainer(deps));
      return { data: await svc.reschedule(projectId, scheduleId, scheduledAt) };
    },
  });

  tools.push({
    name: 'schedule_cancel',
    title: 'Cancel a pending publication schedule',
    description:
      'Cancel a pending content publication schedule. The backing job is cancelled and the schedule will not publish. Scheduling and publication history are preserved (the row is never deleted) and cancelling twice is a harmless no-op (schema v1, write). For account/master keys project_id must be a project you are a member of with editor access.',
    readOnly: false,
    inputSchema: {
      project_id: z.string().uuid().describe('Project to operate on (the one this API key is bound to, or any project you are a member of for account keys)'),
      schedule_id: z.string().uuid().describe('Schedule to cancel'),
    },
    handler: async (deps, args) => {
      requireWrite(deps);
      const projectId = await resolveProjectId(deps, args, 'write');
      const scheduleId = requireUuid(args.schedule_id, 'schedule_id');
      const svc = new ScheduleService(fullContainer(deps));
      return { data: await svc.cancel(projectId, scheduleId) };
    },
  });

  // ---------------------------------------------------------------------------
  // Publication history (read over PublicationService)
  // ---------------------------------------------------------------------------

  tools.push({
    name: 'publication_list',
    title: 'List publication attempts',
    description:
      'List publication attempts and outcomes for a project - what was published, failed, or is currently publishing, newest first. Optionally filter by content, publisher, schedule or status. Returns safe metadata only; never article bodies or credentials (schema v1, read). For account/master keys project_id must be a project you are a member of.',
    readOnly: true,
    inputSchema: {
      project_id: z.string().uuid().describe('Project to operate on (the one this API key is bound to, or any project you are a member of for account keys)'),
      content_id: z.string().uuid().optional().describe('Only attempts of this content item'),
      publisher_id: z.string().uuid().optional().describe('Only attempts through this publisher'),
      schedule_id: z.string().uuid().optional().describe('Only attempts created by this schedule'),
      status: z.enum(PUBLICATION_STATUSES).optional().describe('Filter by publication status'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows'),
      offset: z.number().int().min(0).optional().describe('Skip N rows for paging'),
    },
    handler: async (deps, args) => {
      requireRead(deps);
      const projectId = await resolveProjectId(deps, args, 'read');
      const svc = new PublicationService(deps.sb);
      const data = await svc.list(projectId, {
        content_id: uuidArg(args.content_id, 'content_id'),
        publisher_id: uuidArg(args.publisher_id, 'publisher_id'),
        schedule_id: uuidArg(args.schedule_id, 'schedule_id'),
        status: enumArg(args.status, PUBLICATION_STATUSES, 'status'),
        limit: intArg(args.limit, 50, 1, 200),
        offset: intArg(args.offset, 0, 0, 100000),
      });
      return { data };
    },
  });

  tools.push({
    name: 'publication_get',
    title: 'Get a publication attempt',
    description:
      'Fetch one publication attempt by id - its status, target URL, publish time and any failure message. Safe metadata only; never article bodies or credentials (schema v1, read). For account/master keys project_id must be a project you are a member of.',
    readOnly: true,
    inputSchema: {
      project_id: z.string().uuid().describe('Project to operate on (the one this API key is bound to, or any project you are a member of for account keys)'),
      publication_id: z.string().uuid().describe('Publication attempt id'),
    },
    handler: async (deps, args) => {
      requireRead(deps);
      const projectId = await resolveProjectId(deps, args, 'read');
      const publicationId = requireUuid(args.publication_id, 'publication_id');
      const svc = new PublicationService(deps.sb);
      return { data: await svc.get(projectId, publicationId) };
    },
  });

  return tools;
}

/** Validate a required UUID-shaped argument, returning it as a string. */
function requireUuid(value: unknown, field: string): string {
  const s = uuidArg(value, field);
  if (!s) throw new ApiError(400, 'invalid_input', `${field} is required`);
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accept an optional UUID filter (absent -> undefined, present -> validated). */
function uuidArg(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const s = String(value);
  if (!UUID_RE.test(s)) throw new ApiError(400, 'invalid_input', `${field} must be a valid UUID`);
  return s;
}

/** Registers every tool the bound key's scopes allow on an MCP server instance. */
export function registerTools(
  server: { registerTool: (...args: unknown[]) => unknown },
  deps: MpcDeps,
): void {
  for (const tool of buildTools()) {
    if (tool.readOnly ? !deps.canRead : !deps.canWrite) continue;
    const handler = async (args: Record<string, unknown>) => {
      try {
        return ok(okText(await tool.handler(deps, args)));
      } catch (err) {
        const message =
          err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : 'Unknown tool error';
        return fail(message);
      }
    };
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: `${tool.description}\nScope: ${tool.readOnly ? 'read' : 'write'} (schema v1).`,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: true },
      },
      handler,
    );
  }
}
