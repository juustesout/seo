/**
 * Content API (project-scoped): structured content CRUD for the Content
 * Studio. Routes are thin: authorization happens here, then the SEO Core
 * ContentService does the work (shared later by REST v1 + MCP).
 *
 * Mounted at /api/projects/:projectId/content. Session-authenticated with role
 * gates (container.access.requireRole): viewers read/list/analyze, editors
 * create/update and queue AI work, admins delete. Slow provider-driven work
 * (staged generation, media resolution, full analysis) is enqueued as a job and
 * returns 202 - HTTP handlers never block on AI/provider calls.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseId, parseProjectId } from './utils.js';
import { ContentService, contentJsonSchema, CONTENT_STATUSES } from '../../services/contentService.js';
import { ContentAnalysisService } from '../../services/contentAnalysisService.js';
import { ContentAiService } from '../../services/contentAiService.js';
import {
  ContentAiEditService,
  MAX_INSTRUCTION_CHARS,
  MAX_SELECTION_CHARS,
} from '../../services/contentAiEditService.js';
import { ContentIntelligenceService } from '../../services/contentIntelligenceService.js';
import { startContentDraft } from '../../services/contentDraftService.js';
import {
  CONTENT_AI_ACTIONS,
  CONTENT_AI_EDIT_OPERATIONS,
  WRITER_EXECUTION_PROFILE_IDS,
  WRITER_FORMAT_IDS,
} from '@seo/contracts';

export const contentRouter: Router = Router({ mergeParams: true });

contentRouter.use(requireAuth);

const contentInputSchema = z
  .object({
    title: z.string().min(1).max(300),
    slug: z.string().max(200).nullable().optional(),
    url: z.string().max(2000).nullable().optional(),
    target_keyword: z.string().max(200).nullable().optional(),
    meta_title: z.string().max(300).nullable().optional(),
    meta_description: z.string().max(1000).nullable().optional(),
    excerpt: z.string().max(2000).nullable().optional(),
    language: z.string().max(16).optional(),
    status: z.enum(CONTENT_STATUSES).optional(),
    content_json: contentJsonSchema.optional(),
  })
  .passthrough();

const patchSchema = contentInputSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'Provide at least one field to update',
});

const generateSchema = z
  .object({
    topic: z.string().min(3).max(500),
    target_keyword: z.string().max(200).optional(),
    language: z.string().max(16).optional(),
    audience: z.string().max(300).optional(),
    tone: z.string().max(100).optional(),
    content_length: z.enum(['short', 'medium', 'long']).optional(),
    include_knowledge: z.boolean().optional(),
    image_hint: z.string().max(200).nullable().optional(),
    image_count: z.number().int().min(1).max(4).optional(),
  })
  .passthrough();

const imagesSchema = z
  .object({
    image_provider: z.enum(['unsplash', 'openai_media']),
    limit: z.number().int().min(1).max(6).optional(),
  })
  .passthrough();

/** Queue the staged content agent pipeline as a job (never blocks HTTP). */
contentRouter.post(
  '/generate',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = generateSchema.parse(req.body);
    const job = await container.jobStore.enqueue({
      project_id: projectId,
      provider: 'content',
      job_type: 'content_generate',
      params: body,
      created_by: user!.sub,
    });
    res.status(202).json({ data: { job } });
  }),
);

/** Resolve media placeholders in a draft via a media provider (job). */
contentRouter.post(
  '/:id/images',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = imagesSchema.parse(req.body);
    const svc = new ContentService(container.sb);
    await svc.get(projectId, parseId(req, 'id'));
    const job = await container.jobStore.enqueue({
      project_id: projectId,
      provider: 'content',
      job_type: 'content_images',
      params: { content_id: parseId(req, 'id'), image_provider: body.image_provider, limit: body.limit },
      created_by: user!.sub,
    });
    res.status(202).json({ data: { job } });
  }),
);

const analyzeSchema = z.object({ with_ai: z.boolean().optional() }).passthrough();

/** Legacy selection-scoped AI action (plain-text suggestion, review-before-apply). */
const contentAiActionSchema = z
  .object({
    action: z.enum(CONTENT_AI_ACTIONS),
    selection: z.string().max(8000).nullable().optional(),
    instruction: z.string().max(500).nullable().optional(),
    tone: z.string().max(120).nullable().optional(),
    context: z.string().max(4000).nullable().optional(),
    keyword: z.string().max(200).nullable().optional(),
    use_knowledge: z.boolean().optional(),
  })
  .passthrough();

/**
 * Cosmos AI editor: one request path for Rewrite/Improve/Shorten/Expand/Ask AI.
 * The body carries the selection position/text plus an optional instruction; the
 * server gathers all authoritative context (nearby document text, metadata,
 * Cosmos, SEO, knowledge) itself.
 */
const contentAiEditSchema = z
  .object({
    operation: z.enum(CONTENT_AI_EDIT_OPERATIONS),
    selection: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).strict(),
    text: z.string().trim().min(1).max(MAX_SELECTION_CHARS),
    instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_CHARS).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.selection.to <= value.selection.from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'selection.to must be greater than selection.from',
        path: ['selection', 'to'],
      });
    }
    if (value.operation === 'ask' && !value.instruction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Add an instruction for Ask AI.',
        path: ['instruction'],
      });
    }
  });

/**
 * Agent Controls: generate a NEW draft from this article through the shared
 * Writer Engine (a normal content_write job). `contentId: null` is enforced
 * server-side, so the article being edited is never mutated.
 */
const contentDraftSchema = z
  .object({
    mode: z.enum(WRITER_EXECUTION_PROFILE_IDS).optional(),
    format: z.enum(WRITER_FORMAT_IDS).optional(),
    idempotency_key: z.string().trim().min(1).max(200).optional(),
  })
  .passthrough();

/** Start a new Writer Engine draft from this article (never overwrites it). */
contentRouter.post(
  '/:id/draft',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const contentId = parseId(req, 'id');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = contentDraftSchema.parse(req.body ?? {});
    const { job, reused } = await startContentDraft(container, {
      projectId,
      contentId,
      userId: user!.sub,
      mode: body.mode,
      format: body.format,
      idempotencyToken: body.idempotency_key,
    });
    res.status(202).json({ data: { job, reused } });
  }),
);

/**
 * Run one in-editor AI action (legacy plain-text suggestion). Returns a
 * structured suggestion only - the document is never modified server-side; the
 * editor applies or rejects it.
 */
contentRouter.post(
  '/:id/ai',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = contentAiActionSchema.parse(req.body);
    const svc = new ContentAiService(container);
    const suggestion = await svc.run(projectId, parseId(req, 'id'), {
      action: body.action,
      selection: body.selection ?? null,
      instruction: body.instruction ?? null,
      tone: body.tone ?? null,
      context: body.context ?? null,
      keyword: body.keyword ?? null,
      useKnowledge: body.use_knowledge ?? true,
    });
    res.json({ data: suggestion });
  }),
);

/**
 * Cosmos AI editor: one selection-scoped structured edit. The model returns a
 * validated `replace_selection` operation; the editor previews it and applies
 * it to the selected range only. The whole document is never replaced.
 */
contentRouter.post(
  '/:id/ai/edit',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = contentAiEditSchema.parse(req.body);
    const svc = new ContentAiEditService(container);
    const result = await svc.run(projectId, parseId(req, 'id'), body);
    res.json({ data: result });
  }),
);

/** Deterministic audit (no network) - returns the reusable report shape. */
contentRouter.get(
  '/:id/analysis',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const svc = new ContentAnalysisService(container);
    const result = await svc.analyze(projectId, parseId(req, 'id'));
    res.json({ data: result });
  }),
);

/** Full analysis (deterministic + optional AI pass) persisted via job. */
contentRouter.post(
  '/:id/analyze',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = analyzeSchema.parse(req.body);
    const svc = new ContentService(container.sb);
    await svc.get(projectId, parseId(req, 'id'));
    const job = await container.jobStore.enqueue({
      project_id: projectId,
      provider: 'content',
      job_type: 'content_analyze',
      params: { content_id: parseId(req, 'id'), with_ai: body.with_ai !== false },
      created_by: user!.sub,
    });
    res.status(202).json({ data: { job } });
  }),
);

/**
 * Content intelligence (Phase G): read-only aggregate of deterministic
 * signals (SEO, GSC, DataForSEO, Knowledge) with an optional, explicit AI
 * assistant pass (?with_ai=1). Never mutates; never blocks on providers.
 */
contentRouter.get(
  '/:id/intelligence',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const svc = new ContentIntelligenceService(container);
    const report = await svc.report(projectId, parseId(req, 'id'), {
      withAi: req.query.with_ai === 'true' || req.query.with_ai === '1',
    });
    res.json({ data: report });
  }),
);

/** List project content (viewer+), with optional search and status filters. */
contentRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const svc = new ContentService(container.sb);
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === 'string' && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 200;
    const result = await svc.list(projectId, {
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      limit,
    });
    res.json({ data: result });
  }),
);

/** Fetch one content item with its structured blocks and rendered HTML (viewer+). */
contentRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const svc = new ContentService(container.sb);
    res.json({ data: await svc.get(projectId, parseId(req, 'id')) });
  }),
);

/** Create a content item (editor+). Structured content_json is the source of truth. */
contentRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = contentInputSchema.parse(req.body);
    const svc = new ContentService(container.sb);
    const row = await svc.create(projectId, user!.sub, toService(body));
    res.status(201).json({ data: row });
  }),
);

/** Update metadata/blocks/status of one item (editor+). */
contentRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = patchSchema.parse(req.body);
    const svc = new ContentService(container.sb);
    const row = await svc.update(projectId, user!.sub, parseId(req, 'id'), toService(body as never));
    res.json({ data: row });
  }),
);

/** Delete one content item (admin only - destructive, so not available to editors). */
contentRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const svc = new ContentService(container.sb);
    await svc.remove(projectId, parseId(req, 'id'));
    res.status(204).send();
  }),
);

/**
 * Map the snake_case API body onto the service layer's camelCase input,
 * dropping keys the caller omitted so partial patches do not null out fields
 * they did not mean to touch.
 */
function toService(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {
    title: body.title,
    slug: body.slug,
    url: body.url,
    targetKeyword: body.target_keyword,
    metaTitle: body.meta_title,
    metaDescription: body.meta_description,
    excerpt: body.excerpt,
    language: body.language,
    status: body.status,
    contentJson: body.content_json,
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out as never;
}
