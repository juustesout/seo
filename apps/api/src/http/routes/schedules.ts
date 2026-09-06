/**
 * Content schedule API (Content Studio Phase H1), project-scoped.
 * Routes are thin: authorization happens here, then the SEO Core ScheduleService
 * does the work (shared later by REST v1 + MCP). DELETE means cancel - a
 * schedule is a planning row and is never hard-deleted.
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
  scheduled_at: z.string().min(1).max(64),
});

const updateScheduleSchema = z.object({
  scheduled_at: z.string().min(1).max(64),
});

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
