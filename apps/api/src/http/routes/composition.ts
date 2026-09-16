/**
 * Composition API (Stage 7 + 8B).
 *
 * Two small project-scoped endpoints:
 *   - POST /plan    - turn a bounded brief into a validated composition plan
 *                     (a storyboard). Structure only, no copy.
 *   - POST /compose - run the full chain: plan (unless a validated plan is
 *                     supplied) -> compile -> writer slot filling -> filled
 *                     canonical document.
 *
 * editor+ may plan/compose; viewer cannot. Nothing is persisted and no
 * canonical document is produced by the planner - the AI boundary may only
 * propose structure.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  COMPOSITION_PLAN_FORMAT_IDS,
  COMPOSITION_PLANNER_BRIEF_MAX_CHARS,
  COMPOSITION_PLANNER_BRIEF_MIN_CHARS,
  isValidCompositionPlan,
} from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseProjectId } from './utils.js';
import { CompositionPlannerService } from '../../services/compositionPlannerService.js';
import { CompositionService } from '../../services/compositionService.js';

export const compositionRouter: Router = Router({ mergeParams: true });

compositionRouter.use(requireAuth);

const briefSchema = z
  .string()
  .trim()
  .min(COMPOSITION_PLANNER_BRIEF_MIN_CHARS)
  .max(COMPOSITION_PLANNER_BRIEF_MAX_CHARS);

const compositionPlanRequestSchema = z
  .object({
    brief: briefSchema,
    format: z.enum(COMPOSITION_PLAN_FORMAT_IDS).optional(),
  })
  .strict();

const composeRequestSchema = z
  .object({
    brief: briefSchema,
    format: z.enum(COMPOSITION_PLAN_FORMAT_IDS).optional(),
    /** Optional pre-validated plan to skip re-planning (same-plan two-step flow). */
    plan: z.unknown().optional().refine((value) => value === undefined || isValidCompositionPlan(value), {
      message: 'Invalid composition plan',
    }),
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

/** Run the full composition (plan + writer slot filling) (editor+). Never persists. */
compositionRouter.post(
  '/compose',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = composeRequestSchema.parse(req.body ?? {});
    res.json({ data: await new CompositionService(container).compose(projectId, body) });
  }),
);

