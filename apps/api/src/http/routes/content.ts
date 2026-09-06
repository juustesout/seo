/**
 * Content API (project-scoped): structured content CRUD for the Content
 * Studio. Routes are thin: authorization happens here, then the SEO Core
 * ContentService does the work (shared later by REST v1 + MCP).
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseId, parseProjectId } from './utils.js';
import { ContentService, contentJsonSchema, CONTENT_STATUSES } from '../../services/contentService.js';
import { ContentAnalysisService } from '../../services/contentAnalysisService.js';

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
    seo_score: z.number().min(0).max(100).nullable().optional(),
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
    seoScore: body.seo_score,
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out as never;
}
