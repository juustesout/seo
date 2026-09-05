/**
 * SEO MCP server (Milestone 9).
 *
 * Exposes the same SEO Core services (ContentService, ContentAnalysisService)
 * that REST v1 and the UI use. Invariants:
 *  - Identity is a project API key bound at startup (MCP_API_KEY env). The
 *    caller can only ever reach that key's project - a project id supplied by
 *    the client is never trusted (write tools take no project field at all).
 *  - Read tools require the key's "read" scope; write tools require "write".
 *  - Destructive/state transitions (publish/archive) demand an explicit
 *    confirmation argument. Deletion is intentionally not exposed.
 *  - Long operations enqueue durable jobs and return a job id to poll.
 *  - Tool schemas are versioned in each description (schema vN).
 */

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobStore } from '../jobs/types.js';
import type { ServiceContainer } from '../context.js';
import { ContentService } from '../services/contentService.js';
import { ContentAnalysisService } from '../services/contentAnalysisService.js';
import { ApiError } from '../apiErrors.js';

const asContainer = (sb: SupabaseClient): ServiceContainer => ({ sb } as unknown as ServiceContainer);

export interface MpcDeps {
  sb: SupabaseClient;
  jobStore: JobStore;
  /** Project the bound key belongs to (authoritative). */
  projectId: string;
  /** User id recorded on writes (the key creator when known). */
  userId: string | null;
  canRead: boolean;
  canWrite: boolean;
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

function okText(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export function buildTools(): ToolDef[] {
  const tools: ToolDef[] = [];

  tools.push({
    name: 'content_list',
    title: 'List content',
    description: 'List project content items (schema v1, read).',
    readOnly: true,
    inputSchema: {
      status: z.enum(['draft', 'in_review', 'published', 'archived']).optional().describe('Filter by status'),
      search: z.string().max(200).optional().describe('Substring match on title'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows'),
    },
    handler: async (deps, args) => {
      requireRead(deps);
      const svc = new ContentService(deps.sb);
      const result = await svc.list(deps.projectId, {
        status: typeof args.status === 'string' ? args.status : undefined,
        search: typeof args.search === 'string' ? args.search : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 200,
      });
      return { data: result };
    },
  });

  tools.push({
    name: 'content_get',
    title: 'Get content',
    description: 'Fetch a content item with its structured blocks and rendered HTML (schema v1, read).',
    readOnly: true,
    inputSchema: { id: z.string().uuid().describe('Content id') },
    handler: async (deps, args) => {
      requireRead(deps);
      const svc = new ContentService(deps.sb);
      return { data: await svc.get(deps.projectId, String(args.id)) };
    },
  });

  tools.push({
    name: 'content_analyze',
    title: 'Analyze content',
    description:
      'Deterministic SEO audit (score/issues/warnings/recommendations) of one content item (schema v1, read, no persistence).',
    readOnly: true,
    inputSchema: { id: z.string().uuid().describe('Content id') },
    handler: async (deps, args) => {
      requireRead(deps);
      const svc = new ContentAnalysisService(asContainer(deps.sb));
      return { data: await svc.analyze(deps.projectId, String(args.id)) };
    },
  });

  tools.push({
    name: 'jobs_list',
    title: 'List jobs',
    description: 'List recent project jobs so async results can be polled (schema v1, read).',
    readOnly: true,
    inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('Max rows') },
    handler: async (deps, args) => {
      requireRead(deps);
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const { data, error } = await deps.sb
        .from('seo_sync_jobs')
        .select('id, job_type, status, progress, message, result, error, created_at, completed_at')
        .eq('project_id', deps.projectId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new ApiError(400, 'bad_request', 'Could not read jobs');
      return { data: data ?? [] };
    },
  });

  tools.push({
    name: 'content_generate',
    title: 'Generate content draft',
    description:
      'Run the staged content agent (brief/outline/article) as a durable job and return the job id (schema v1, write). Poll jobs_list.',
    readOnly: false,
    inputSchema: {
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
      const job = await deps.jobStore.enqueue({
        project_id: deps.projectId,
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
      'Fill media placeholders of a draft with real images via a media provider (schema v1, write). Poll jobs_list.',
    readOnly: false,
    inputSchema: {
      id: z.string().uuid().describe('Content id'),
      image_provider: z.enum(['unsplash', 'openai_media']).default('unsplash'),
      limit: z.number().int().min(1).max(6).optional(),
    },
    handler: async (deps, args) => {
      requireWrite(deps);
      const job = await deps.jobStore.enqueue({
        project_id: deps.projectId,
        provider: 'content',
        job_type: 'content_images',
        params: { content_id: args.id, image_provider: args.image_provider, limit: args.limit },
        created_by: deps.userId,
      });
      return { data: { job, note: 'Job queued - poll jobs_list for progress.' } };
    },
  });

  tools.push({
    name: 'content_update',
    title: 'Update content',
    description:
      'Update content metadata, blocks or status (schema v1, write). Publishing/archiving requires confirm=true.',
    readOnly: false,
    inputSchema: {
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
      const status = args.status as string | undefined;
      if ((status === 'published' || status === 'archived') && args.confirm !== true) {
        throw new ApiError(400, 'confirmation_required', 'Set confirm=true to publish or archive content');
      }
      const str = (v: unknown): string | null | undefined => (typeof v === 'string' || v === null || v === undefined ? v : undefined);
      const svc = new ContentService(deps.sb);
      const row = await svc.update(deps.projectId, deps.userId, String(args.id), {
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

  return tools;
}

/** Registers every tool on an MCP server instance. */
export function registerTools(
  server: { registerTool: (...args: unknown[]) => unknown },
  deps: MpcDeps,
): void {
  for (const tool of buildTools()) {
    const handler = async (args: Record<string, unknown>) => {
      try {
        return ok(okText(await tool.handler(deps, args)));
      } catch (err) {
        const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Unknown tool error';
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
