/**
 * Publications API (Content Studio Phase H3): create publish targets from
 * saved content and track every publish attempt against third-party outlets.
 *
 * Mounted at /api/projects/:projectId/publications. Session-authenticated with
 * role gates: viewers read history + detail, editors enqueue and manage
 * publications. Publication is always asynchronous work - POST only inserts a
 * durable row and enqueues a worker job; HTTP never blocks on the publisher
 * call. Publishers resolve through container (project-scoped, connected only),
 * and capability checks use the shared contracts helper so a channel that
 * cannot carry image/video intent is rejected up front.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { PublishContentKind } from '@seo/contracts';
import { publisherCanPublishKind } from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseId, parseProjectId } from './utils.js';
import { PublicationService, PUBLICATION_STATUSES } from '../../services/publicationService.js';
import {
  actionPublishIdentity,
  directPublishIdentity,
  enqueuePublicationJob,
  publishJobType,
  reusablePublicationJob,
} from '../../services/publicationJobs.js';

export const publicationsRouter: Router = Router({ mergeParams: true });

publicationsRouter.use(requireAuth);

/** Load a publisher row, failing unless it belongs to this project. */
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

/** Capability gate (Phase H6.1): reject intents the publisher cannot carry. */
function requirePublishKindCapability(publisher: Record<string, unknown>, publishKind: PublishContentKind): void {
  const capabilities = Array.isArray(publisher.capabilities) ? (publisher.capabilities as string[]) : [];
  if (!publisherCanPublishKind(publishKind, capabilities)) {
    const known = capabilities.length > 0 ? capabilities.join(', ') : 'none declared';
    throw ApiError.badRequest(`Publisher '${String(publisher.name)}' cannot publish '${publishKind}' content (capabilities: ${known})`);
  }
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

/** One publication attempt, filtered/paginated server-side. */
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
        /** Publication intent; defaults to article. */
        publish_kind: z.enum(['article', 'text', 'image', 'video']).default('article'),
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
    requirePublishKindCapability(publisher, body.publish_kind);

    if (body.content_id) {
      const { data } = await container.sb
        .from('seo_content')
        .select('id, title, body')
        .eq('project_id', projectId)
        .eq('id', body.content_id)
        .maybeSingle();
      if (!data) throw ApiError.notFound('Referenced content does not exist in this project');
    }

    const scheduledFor = body.schedule_for ? new Date(body.schedule_for).toISOString() : null;

    // The logical operation is the publish intent itself (publisher + payload
    // snapshot), so a repeated identical submission collapses onto the first
    // one instead of publishing twice, while a changed/new document is a
    // genuinely new operation.
    const identity = directPublishIdentity({
      projectId,
      publisherId: body.publisher_id,
      publishKind: body.publish_kind,
      remoteStatus: body.remote_status,
      contentId: body.content_id ?? null,
      title: body.title,
      slug: body.slug ?? null,
      content: body.content,
      excerpt: body.excerpt ?? null,
      scheduledFor,
    });

    const inFlight = await reusablePublicationJob(container, projectId, identity);
    if (inFlight) {
      const existingId = typeof inFlight.params.publication_id === 'string' ? inFlight.params.publication_id : null;
      const { data: existing } = existingId
        ? await container.sb.from('seo_publications').select('*').eq('project_id', projectId).eq('id', existingId).maybeSingle()
        : { data: null };
      res.status(202).json({ data: { publication: existing ?? null, job: inFlight, reused: true } });
      return;
    }

    const { data: publication, error } = await container.sb
      .from('seo_publications')
      .insert({
        project_id: projectId,
        publisher_id: body.publisher_id,
        content_id: body.content_id ?? null,
        status: body.schedule_for ? 'scheduled' : 'queued',
        publish_kind: body.publish_kind,
        title: body.title,
        slug: body.slug ?? null,
        content: body.content,
        excerpt: body.excerpt ?? null,
        scheduled_for: scheduledFor,
        created_by: user!.sub,
      } as never)
      .select()
      .single();
    if (error) throw ApiError.badRequest(`Could not create publication: ${error.message}`);

    const { job, reused } = await enqueuePublicationJob(container, {
      projectId,
      userId: user!.sub,
      identity,
      provider: String(publisher.provider),
      jobType: 'publish',
      params: { publication_id: publication.id, remote_status: body.remote_status },
      runAfter: scheduledFor ?? undefined,
    });

    if (reused) {
      // A concurrent identical submission won the idempotency key; this row was
      // never backed by a job, so record it honestly instead of leaving it stuck.
      await container.sb
        .from('seo_publications')
        .update({ status: 'failed', error: 'Duplicate publish submission collapsed onto an in-flight publication' })
        .eq('project_id', projectId)
        .eq('id', publication.id);
      const existingId = typeof job.params.publication_id === 'string' ? job.params.publication_id : null;
      const { data: winner } = existingId
        ? await container.sb.from('seo_publications').select('*').eq('project_id', projectId).eq('id', existingId).maybeSingle()
        : { data: null };
      res.status(202).json({ data: { publication: winner ?? publication, job, reused: true } });
      return;
    }

    res.status(202).json({ data: { publication, job, reused: false } });
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

    // Creating a remote post is a once-per-publication operation: refuse a
    // second create for a row that already has a confirmed remote id (the
    // executor short-circuits the same way for a racing/retried job).
    if (body.action === 'publish' && pub.remote_id) {
      throw ApiError.conflict('This publication already exists remotely; publish creates it at most once');
    }
    if (body.action === 'delete' && pub.status === 'deleted') {
      throw ApiError.conflict('This publication has already been deleted remotely');
    }

    const identity = actionPublishIdentity(publicationId, body.action);
    const { job, reused } = await enqueuePublicationJob(container, {
      projectId,
      userId: user!.sub,
      identity,
      provider: String(publisher.provider),
      jobType: publishJobType(body.action),
      params: { publication_id: publicationId, remote_status: body.remote_status },
    });
    if (!reused) {
      // `queued` is the pending state for both publish and delete; there is no
      // dedicated delete-in-progress status (see seo_publications_status_check).
      await container.sb
        .from('seo_publications')
        .update({ status: 'queued', error: null })
        .eq('project_id', projectId)
        .eq('id', publicationId);
    }
    res.status(202).json({ data: { publicationId, job, reused } });
  }),
);
