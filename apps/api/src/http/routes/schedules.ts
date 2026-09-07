/**
 * Content schedule API (Content Studio Phase H1), project-scoped.
 * Routes are thin: authorization happens here, then the SEO Core ScheduleService
 * does the work (shared later by REST v1 + MCP). DELETE means cancel - a
 * schedule is a planning row and is never hard-deleted.
 *
 * Mounted at /api/projects/:projectId/schedules. Session-authenticated with
 * role gates: viewers list, editors create/reschedule/cancel. A schedule pairs
 * a content item with a publisher (kind defaults to article) and a future
 * timestamp; when it fires, the worker turns it into a queued publication.
 * Everything else - deduplication, ownership checks, honest errors - is in
 * ScheduleService so REST and MCP behave identically.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseId, parseProjectId } from './utils.js';
import { ScheduleService } from '../../services/scheduleService.js';

export const schedulesRouter: Router = Router({ mergeParams: true });

schedulesRouter.use(requireAuth);

const createScheduleSchema = z.object({
  content_id: z.string().uuid(),
  publisher_id: z.string().uuid(),
  /** Publication intent; defaults to article. text lets article content go to a publish_text channel (e.g. X). */
  publish_kind: z.enum(['article', 'text', 'image', 'video']).default('article'),
  scheduled_at: z.string().min(1).max(64),
});

const updateScheduleSchema = z.object({
  scheduled_at: z.string().min(1).max(64),
});

/** List this project's upcoming schedules (viewers). */
schedulesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const svc = new ScheduleService(container);
    res.json({ data: await svc.list(projectId) });
  }),
);

/** Create a schedule (editors). Fires through the worker when scheduled_at passes. */
schedulesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = createScheduleSchema.parse(req.body);
    const svc = new ScheduleService(container);
    const schedule = await svc.create(projectId, user!.sub, body);
    res.status(201).json({ data: schedule });
  }),
);

/** Move a schedule to a new time (editors). */
schedulesRouter.patch(
  '/:scheduleId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const scheduleId = parseId(req, 'scheduleId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = updateScheduleSchema.parse(req.body);
    const svc = new ScheduleService(container);
    res.json({ data: await svc.reschedule(projectId, scheduleId, body.scheduled_at) });
  }),
);

/** Cancel a schedule (editors). The planning row stays - never hard-deleted. */
schedulesRouter.delete(
  '/:scheduleId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const scheduleId = parseId(req, 'scheduleId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const svc = new ScheduleService(container);
    res.json({ data: await svc.cancel(projectId, scheduleId) });
  }),
);
