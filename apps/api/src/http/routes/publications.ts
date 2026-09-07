/** Publications API: create publish targets from saved content and track attempts. */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseId, parseProjectId } from './utils.js';
import { PublicationService, PUBLICATION_STATUSES } from '../../services/publicationService.js';

export const publicationsRouter: Router = Router({ mergeParams: true });

publicationsRouter.use(requireAuth);

async function loadPublisher(container: ReturnType<typeof import('../../context.js').getContainer>, projectId: string, publisherId: string) {
  const { data } = await container.sb
    .from('seo_publishers')
    .select('*')
    .eq('project_id', projectId)
    .eq('id', publisherId)
    .maybeSingle();
  if (!data) throw ApiError.notFound('Publisher not found for this project');
  return data as Record<string, unknown>;
}

/**
 * Publication history list (Content Studio Phase H3). Project-scoped read that
 * returns safe PublicationDto metadata only - never article bodies, publisher
 * credentials or worker internals. Filters + pagination are enforced by the
 * API so clients never pull whole tables.
 */
const listQuerySchema = z.object({
  content_id: z.string().uuid().optional(),
  publisher_id: z.string().uuid().optional(),
  schedule_id: z.string().uuid().optional(),
  status: z.enum(PUBLICATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

publicationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const filters = listQuerySchema.parse(req.query);
    const svc = new PublicationService(container.sb);
    res.json({ data: await svc.list(projectId, filters) });
  }),
);

publicationsRouter.get(
  '/:publicationId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publicationId = parseId(req, 'publicationId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const svc = new PublicationService(container.sb);
    res.json({ data: await svc.get(projectId, publicationId) });
  }),
);

/**
 * Enqueue a publish operation for a publication. Requires a connected publisher
 * so users get immediate, actionable feedback instead of a silent dead job.
 */
publicationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');

    const body = z
      .object({
        publisher_id: z.string().uuid(),
        content_id: z.string().uuid().optional().nullable(),
        title: z.string().min(1).max(500),
        slug: z.string().max(300).optional(),
        content: z.string().optional().default(''),
        excerpt: z.string().max(1000).optional(),
        remote_status: z.enum(['publish', 'draft']).default('publish'),
        schedule_for: z.string().optional(),
      })
      .parse(req.body);

    const publisher = await loadPublisher(container, projectId, body.publisher_id);
    if (publisher.status !== 'connected') {
      throw ApiError.badRequest(`Publisher '${publisher.name}' is not connected. Test the connection first.`);
    }

    if (body.content_id) {
      const { data } = await container.sb
        .from('seo_content')
        .select('id, title, body')
        .eq('project_id', projectId)
        .eq('id', body.content_id)
        .maybeSingle();
      if (!data) throw ApiError.notFound('Referenced content does not exist in this project');
    }

    const { data: publication, error } = await container.sb
      .from('seo_publications')
      .insert({
        project_id: projectId,
        publisher_id: body.publisher_id,
        content_id: body.content_id ?? null,
        status: body.schedule_for ? 'scheduled' : 'queued',
        title: body.title,
        slug: body.slug ?? null,
        content: body.content,
        excerpt: body.excerpt ?? null,
        scheduled_for: body.schedule_for ? new Date(body.schedule_for).toISOString() : null,
        created_by: user!.sub,
      } as never)
      .select()
      .single();
    if (error) throw ApiError.badRequest(`Could not create publication: ${error.message}`);

    const job = await container.jobStore.enqueue({
      project_id: projectId,
      provider: String(publisher.provider),
      job_type: 'publish',
      params: { publication_id: publication.id, remote_status: body.remote_status },
      created_by: user!.sub,
      run_after: body.schedule_for ? new Date(body.schedule_for).toISOString() : undefined,
    });

    res.status(202).json({ data: { publication, job } });
  }),
);

/** Re-publish or delete a publication (idempotent on the remote id where relevant). */
publicationsRouter.post(
  '/:publicationId/actions',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publicationId = parseId(req, 'publicationId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = z.object({ action: z.enum(['publish', 'update', 'delete']), remote_status: z.enum(['publish', 'draft']).default('publish') }).parse(req.body);

    const { data } = await container.sb
      .from('seo_publications')
      .select('*')
      .eq('project_id', projectId)
      .eq('id', publicationId)
      .maybeSingle();
    if (!data) throw ApiError.notFound('Publication not found');
    const pub = data as Record<string, unknown>;
    const publisher = await loadPublisher(container, projectId, String(pub.publisher_id));
    if (publisher.status !== 'connected') throw ApiError.badRequest('Publisher is not connected');

    const type = { publish: 'publish', update: 'publish_update', delete: 'publish_delete' }[body.action];
    await container.sb
      .from('seo_publications')
      .update({ status: body.action === 'delete' ? 'queued' : 'queued', error: null })
      .eq('id', publicationId);
    const job = await container.jobStore.enqueue({
      project_id: projectId,
      provider: String(publisher.provider),
      job_type: type,
      params: { publication_id: publicationId, remote_status: body.remote_status },
      created_by: user!.sub,
    });
    res.status(202).json({ data: { publicationId, job } });
  }),
);
