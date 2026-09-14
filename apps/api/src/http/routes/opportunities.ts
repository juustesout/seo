/**
 * Opportunity intelligence API (KW5). Mounted at /api/projects/:projectId/keyword.
 *
 * GET /opportunities - read the deterministic analysis of the project's gap
 * snapshot for the exact active competitor set (viewer+), optionally narrowed by
 * result-view filters. `competitors` is required so the read can never silently
 * describe a different set than the user selected.
 *
 * This is a pure read: it never starts a provider job, never refreshes a
 * snapshot and never persists a derived result. The route is a thin edge that
 * validates the bounded query, enforces project access and delegates to
 * opportunityService.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS,
  COMPETITOR_RESEARCH_MAX_COMPETITORS,
  OPPORTUNITIES_MAX_LIMIT,
  OPPORTUNITY_INTENTS,
  OPPORTUNITY_SORTS,
  OPPORTUNITY_SORT_DIRS,
} from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseProjectId } from './utils.js';
import { getOpportunities } from '../../services/opportunityService.js';

export const opportunitiesRouter: Router = Router({ mergeParams: true });

opportunitiesRouter.use(requireAuth);

const querySchema = z.object({
  competitors: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(
      z
        .array(z.string().max(COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS))
        .min(1)
        .max(COMPETITOR_RESEARCH_MAX_COMPETITORS),
    ),
  domain: z.string().trim().max(COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS).optional(),
  limit: z.coerce.number().int().min(1).max(OPPORTUNITIES_MAX_LIMIT).optional(),
  minVolume: z.coerce.number().nonnegative().optional(),
  maxDifficulty: z.coerce.number().min(0).max(100).optional(),
  intent: z.enum(OPPORTUNITY_INTENTS).optional(),
  sort: z.enum(OPPORTUNITY_SORTS).optional(),
  dir: z.enum(OPPORTUNITY_SORT_DIRS).optional(),
});

/** Read the deterministic opportunity analysis over the active competitor set. */
opportunitiesRouter.get(
  '/opportunities',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const { competitors, domain, ...query } = querySchema.parse(req.query);
    const result = await getOpportunities(container, projectId, competitors, query, domain);
    res.json({ data: result });
  }),
);
