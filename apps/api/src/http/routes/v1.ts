/**
 * REST v1 surface (/api/v1).
 *
 * Project-scoped, API-key authenticated endpoints that call the exact same SEO
 * Core services as the web app (ContentService, ContentAnalysisService), so
 * the REST surface can never drift from the UI. Keys authenticate the project
 * implicitly: the :projectId segment is validated against the key's project,
 * never trusted on its own.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { ApiKeyStore, type ApiKeyRecord, type ApiKeyScope } from '../../infra/apiKeys.js';
import { ContentService, contentJsonSchema, CONTENT_STATUSES } from '../../services/contentService.js';
import { ContentAnalysisService } from '../../services/contentAnalysisService.js';

declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKeyRecord;
    }
  }
}

export const v1Router: Router = Router({ mergeParams: true });

async function requireApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) {
      throw new ApiError(401, 'unauthorized', 'A project API key is required (Authorization: Bearer seo_live_...)');
    }
    const store = new ApiKeyStore(req.container.sb);
    const record = await store.authenticate(token);
    if (!record) {
      throw new ApiError(401, 'unauthorized', 'Invalid or revoked API key');
    }
    req.apiKey = record;
    next();
  } catch (err) {
    next(err);
  }
}

/** The :projectId segment must equal the key's project (project isolation). */
function bindProject(req: Request): void {
  if (req.params.projectId !== req.apiKey!.project_id) {
    throw new ApiError(403, 'forbidden', 'API key does not belong to this project');
  }
}

function requireScope(req: Request, scope: ApiKeyScope): void {
  if (!req.apiKey!.scopes.includes(scope)) {
    throw new ApiError(403, 'forbidden', `API key lacks the "${scope}" scope`);
  }
}

const asContainer = (req: Request) => req.container;

v1Router.get('/projects/:projectId/content', requireApiKey, asyncHandler(async (req, res) => {
  bindProject(req);
  requireScope(req, 'read');
  const svc = new ContentService(asContainer(req).sb);
  const limit = typeof req.query.limit === 'string' && /^\d+$/.test(req.query.limit) ? Number(req.query.limit) : 200;
  const result = await svc.list(req.params.projectId, {
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    limit,
  });
  res.json({ data: result });
}));

v1Router.get('/projects/:projectId/content/:id', requireApiKey, asyncHandler(async (req, res) => {
  bindProject(req);
  requireScope(req, 'read');
  const svc = new ContentService(asContainer(req).sb);
  res.json({ data: await svc.get(req.params.projectId, req.params.id) });
}));

v1Router.get('/projects/:projectId/content/:id/analysis', requireApiKey, asyncHandler(async (req, res) => {
  bindProject(req);
  requireScope(req, 'read');
  const svc = new ContentAnalysisService(asContainer(req));
  res.json({ data: await svc.analyze(req.params.projectId, req.params.id) });
}));

const contentPatchSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    target_keyword: z.string().max(200).nullable().optional(),
    meta_title: z.string().max(300).nullable().optional(),
    meta_description: z.string().max(1000).nullable().optional(),
    excerpt: z.string().max(2000).nullable().optional(),
    status: z.enum(CONTENT_STATUSES).optional(),
    content_json: contentJsonSchema.optional(),
  })
  .passthrough();

v1Router.patch('/projects/:projectId/content/:id', requireApiKey, asyncHandler(async (req, res) => {
  bindProject(req);
  requireScope(req, 'write');
  const body = contentPatchSchema.parse(req.body);
  const svc = new ContentService(asContainer(req).sb);
  const row = await svc.update(req.params.projectId, req.apiKey!.created_by, req.params.id, {
    title: body.title,
    targetKeyword: body.target_keyword,
    metaTitle: body.meta_title,
    metaDescription: body.meta_description,
    excerpt: body.excerpt,
    status: body.status,
    contentJson: body.content_json,
  } as never);
  res.json({ data: row });
}));

v1Router.post('/projects/:projectId/content/:id/analyze', requireApiKey, asyncHandler(async (req, res) => {
  bindProject(req);
  requireScope(req, 'write');
  const body = z.object({ with_ai: z.boolean().optional() }).parse(req.body ?? {});
  const container = asContainer(req);
  const svc = new ContentService(container.sb);
  await svc.get(req.params.projectId, req.params.id);
  const job = await container.jobStore.enqueue({
    project_id: req.params.projectId,
    provider: 'content',
    job_type: 'content_analyze',
    params: { content_id: req.params.id, with_ai: body.with_ai !== false },
    created_by: req.apiKey!.created_by ?? req.apiKey!.id,
  });
  res.status(202).json({ data: { job } });
}));
