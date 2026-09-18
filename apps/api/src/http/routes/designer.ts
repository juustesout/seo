/**
 * Designer API (Stage 8E.6, Phase 2), project-scoped.
 *
 * Two thin, project-authorized endpoints around the DesignerService:
 *   - POST /api/projects/:projectId/designer/execute
 *       run an already-validated `DesignerPlan` and return a reviewable
 *       `DesignerProposal` (never persists; editor+).
 *   - POST /api/projects/:projectId/content/:contentId/designer/apply
 *       apply an explicitly approved proposal through the existing
 *       ContentService save path (editor+). A proposal generated against an
 *       older revision is rejected with `stale_proposal` (409) and no mutation.
 *
 * Phase 2 has no AI intent interpreter: callers supply a plan. The Designer
 * never writes seo_content on execute and never publishes.
 *
 * Mounted at:
 *   /api/projects/:projectId/designer
 *   /api/projects/:projectId/content/:contentId/designer
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  DESIGNER_BASE_REVISION_MAX_CHARS,
  isValidDesignBrief,
  isValidDesignerPlan,
  isValidDesignerProposal,
} from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseId, parseProjectId } from './utils.js';
import { DesignerService } from '../../services/designerService.js';

export const designerRouter: Router = Router({ mergeParams: true });
export const contentDesignerRouter: Router = Router({ mergeParams: true });

designerRouter.use(requireAuth);
contentDesignerRouter.use(requireAuth);

const briefSchema = z.unknown().refine((value) => value === undefined || isValidDesignBrief(value), {
  message: 'Invalid design brief',
});

const executeSchema = z
  .object({
    plan: z.unknown().refine(isValidDesignerPlan, { message: 'Invalid designer plan' }),
    brief: briefSchema.optional(),
    content_id: z.string().uuid().optional(),
    base_revision: z.string().min(1).max(DESIGNER_BASE_REVISION_MAX_CHARS).optional(),
  })
  .strict();

const applySchema = z
  .object({
    proposal: z.unknown().refine(isValidDesignerProposal, { message: 'Invalid designer proposal' }),
  })
  .strict();

/** Run a Designer plan into a proposal (editor+). Never persists. */
designerRouter.post(
  '/execute',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = executeSchema.parse(req.body ?? {});
    const proposal = await new DesignerService(container).execute(projectId, {
      plan: body.plan,
      brief: body.brief,
      contentId: body.content_id,
      baseRevision: body.base_revision,
    });
    res.json({ data: { proposal } });
  }),
);

/** Apply an approved proposal to one content item (editor+). */
contentDesignerRouter.post(
  '/apply',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const contentId = parseId(req, 'contentId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = applySchema.parse(req.body ?? {});
    const row = await new DesignerService(container).apply(projectId, contentId, body.proposal, user!.sub);
    res.json({ data: row });
  }),
);
