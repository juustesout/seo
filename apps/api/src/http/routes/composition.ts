/**
 * Composition planning API (Stage 7).
 *
 * One small project-scoped endpoint that turns a bounded brief into a validated
 * composition plan (a storyboard), using the project's configured AI provider.
 * editor+ may plan; viewer cannot. The plan is never persisted and no canonical
 * document is produced here - the AI boundary may only propose structure.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  COMPOSITION_PLAN_FORMAT_IDS,
  COMPOSITION_PLANNER_BRIEF_MAX_CHARS,
  COMPOSITION_PLANNER_BRIEF_MIN_CHARS,
} from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseProjectId } from './utils.js';
import { CompositionPlannerService } from '../../services/compositionPlannerService.js';

export const compositionRouter: Router = Router({ mergeParams: true });

compositionRouter.use(requireAuth);

const compositionPlanRequestSchema = z
  .object({
    brief: z
      .string()
      .trim()
      .min(COMPOSITION_PLANNER_BRIEF_MIN_CHARS)
      .max(COMPOSITION_PLANNER_BRIEF_MAX_CHARS),
    format: z.enum(COMPOSITION_PLAN_FORMAT_IDS).optional(),
  })
  .strict();

/** Propose a composition plan from a brief (editor+). Never persists. */
compositionRouter.post(
  '/plan',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = compositionPlanRequestSchema.parse(req.body ?? {});
    res.json({ data: await new CompositionPlannerService(container).plan(projectId, body) });
  }),
);
