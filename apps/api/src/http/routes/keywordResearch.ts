/**
 * Keyword research API (KW2). Mounted at
 * /api/projects/:projectId/keyword.
 *
 * POST /research      - start one research run from a single seed keyword (editor+)
 * GET  /research/:jobId - read exactly that run's bounded result (viewer+)
 *
 * The route is a thin edge: it validates input, enforces project access/role
 * and delegates to keywordResearchService. Research runs on the existing
 * dataforseo_keyword_research job path; the browser never talks to DataForSEO
 * and never sees provider credentials or raw responses.
 */

import { Router } from 'express';
import { z } from 'zod';
import { KEYWORD_RESEARCH_SEED_MAX_CHARS } from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseId, parseProjectId } from './utils.js';
import { readKeywordResearchRun, startKeywordResearch } from '../../services/keywordResearchService.js';

export const keywordResearchRouter: Router = Router({ mergeParams: true });

keywordResearchRouter.use(requireAuth);

const researchSchema = z.object({
  seed: z.string().trim().min(1).max(KEYWORD_RESEARCH_SEED_MAX_CHARS),
});

/** Start one research run for one seed keyword. */
keywordResearchRouter.post(
  '/research',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = researchSchema.parse(req.body);
    const run = await startKeywordResearch(container, projectId, user!.sub, body.seed);
    res.status(202).json({ data: run });
  }),
);

/** Read one specific research run by its job id. */
keywordResearchRouter.get(
  '/research/:jobId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const jobId = parseId(req, 'jobId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const run = await readKeywordResearchRun(container, projectId, jobId);
    res.json({ data: run });
  }),
);
