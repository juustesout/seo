/**
 * Content performance API (P7 measurement loop).
 *
 * Turns the platform's persisted facts - what was published, how it ranks in
 * Search Console and how much GA4 traffic the page got - into one project-scoped
 * report. Read is viewer+; triggering a refresh is editor+ and asynchronous
 * (the same seo_sync_jobs the UI already polls). Nothing here calls Google
 * during a read, and a provider that is not configured is reported as a note.
 *
 * Mounted at /api/projects/:projectId/performance.
 */

import { Router } from 'express';
import type { ContentPerformanceReportDto, ContentPerformanceSyncDto } from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseProjectId } from './utils.js';
import {
  ContentPerformanceService,
  resolvePerformancePeriodDays,
  syncContentPerformance,
} from '../../services/contentPerformanceService.js';

export const projectPerformanceRouter: Router = Router({ mergeParams: true });

projectPerformanceRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// GET / - publication -> search/traffic report over the selected period
// ---------------------------------------------------------------------------

projectPerformanceRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const days = resolvePerformancePeriodDays(req.query.days ?? 28);
    const data: ContentPerformanceReportDto = await new ContentPerformanceService(container).report(projectId, days);
    res.json({ data });
  }),
);

// ---------------------------------------------------------------------------
// POST /sync - refresh GSC and/or GA4 data for the loop
// ---------------------------------------------------------------------------

projectPerformanceRouter.post(
  '/sync',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const days = resolvePerformancePeriodDays(req.body?.days ?? 28);
    const data: ContentPerformanceSyncDto = await syncContentPerformance(container, {
      projectId,
      userId: user!.sub,
      days,
    });
    res.status(202).json({ data });
  }),
);
