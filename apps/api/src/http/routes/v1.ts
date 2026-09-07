/**
 * REST v1 surface (/api/v1).
 *
 * Project-scoped, API-key authenticated endpoints that call the exact same SEO
 * Core services as the web app (ContentService, ContentAnalysisService), so
 * the REST surface can never drift from the UI.
 *
 * Two key kinds are accepted:
 *  - Project keys: bound to one project; the :projectId segment must equal the
 *    key's project.
 *  - Account (master) keys: bound to the owning user; :projectId may be any
 *    project that user is a member of, resolved per request. A master key
 *    never acts stronger than the creator's membership role in that project
 *    (writes additionally require the editor role), so an owner/admin can hand
 *    a master key to an agent without ever granting more than their own reach.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { ApiKeyStore, type ApiKeyRecord, type ApiKeyScope } from '../../infra/apiKeys.js';
import type { AccessService } from '../../supabase.js';
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
      throw new ApiError(401, 'unauthorized', 'An API key is required (Authorization: Bearer seo_live_...)');
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

/**
 * Resolves + authorizes the :projectId segment against the authenticated key.
 *  - Project key: must equal the key's project (project isolation).
 *  - Account key: the key creator must be a member of the target project with
 *    at least the requested role (viewer for reads, editor for writes). This
 *    keeps a master key capped at the creator's own membership, per request.
 *
 * Exported so route middleware and tests share the exact same authorization.
 */
export async function authorizeKeyProject(
  access: Pick<AccessService, 'requireRole'>,
  key: ApiKeyRecord,
  requested: string,
  minRole: 'viewer' | 'editor',
): Promise<string> {
  if (key.project_id !== null) {
    if (requested !== key.project_id) {
      throw new ApiError(403, 'forbidden', 'API key does not belong to this project');
    }
    return requested;
  }
  if (!key.created_by) {
    throw new ApiError(403, 'forbidden', 'This account API key has no owner identity');
  }
  await access.requireRole(key.created_by, requested, minRole);
  return requested;
}

async function authorizeProject(req: Request, minRole: 'viewer' | 'editor'): Promise<string> {
  return authorizeKeyProject(req.container.access, req.apiKey!, req.params.projectId, minRole);
}

function requireScope(req: Request, scope: ApiKeyScope): void {
  if (!req.apiKey!.scopes.includes(scope)) {
    throw new ApiError(403, 'forbidden', `API key lacks the "${scope}" scope`);
  }
}

const asContainer = (req: Request) => req.container;

v1Router.get('/projects/:projectId/content', requireApiKey, asyncHandler(async (req, res) => {
  requireScope(req, 'read');
  const projectId = await authorizeProject(req, 'viewer');
  const svc = new ContentService(asContainer(req).sb);
  const limit = typeof req.query.limit === 'string' && /^\d+$/.test(req.query.limit) ? Number(req.query.limit) : 200;
  const result = await svc.list(projectId, {
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    limit,
  });
  res.json({ data: result });
}));

v1Router.get('/projects/:projectId/content/:id', requireApiKey, asyncHandler(async (req, res) => {
  requireScope(req, 'read');
  const projectId = await authorizeProject(req, 'viewer');
  const svc = new ContentService(asContainer(req).sb);
  res.json({ data: await svc.get(projectId, req.params.id) });
}));

v1Router.get('/projects/:projectId/content/:id/analysis', requireApiKey, asyncHandler(async (req, res) => {
  requireScope(req, 'read');
  const projectId = await authorizeProject(req, 'viewer');
  const svc = new ContentAnalysisService(asContainer(req));
  res.json({ data: await svc.analyze(projectId, req.params.id) });
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
  requireScope(req, 'write');
  const projectId = await authorizeProject(req, 'editor');
  const body = contentPatchSchema.parse(req.body);
  const svc = new ContentService(asContainer(req).sb);
  const row = await svc.update(projectId, req.apiKey!.created_by, req.params.id, {
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
  requireScope(req, 'write');
  const projectId = await authorizeProject(req, 'editor');
  const body = z.object({ with_ai: z.boolean().optional() }).parse(req.body ?? {});
  const container = asContainer(req);
  const svc = new ContentService(container.sb);
  await svc.get(projectId, req.params.id);
  const job = await container.jobStore.enqueue({
    project_id: projectId,
    provider: 'content',
    job_type: 'content_analyze',
    params: { content_id: req.params.id, with_ai: body.with_ai !== false },
    created_by: req.apiKey!.created_by ?? req.apiKey!.id,
  });
  res.status(202).json({ data: { job } });
}));
