/**
 * Competitor research API (KW3). Mounted at /api/projects/:projectId/keyword.
 *
 * POST /competitors        - start domain-based competitor discovery (editor+)
 * POST /competitor-gap     - start a gap analysis for up to 3 competitors (editor+)
 * GET  /competitors/:jobId - read exactly that run's bounded result (viewer+)
 *
 * Both modes enqueue the existing `competitor_research` job; the browser never
 * talks to DataForSEO and never sees provider credentials or raw responses.
 */

import { Router } from 'express';
import { z } from 'zod';
import { COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS, COMPETITOR_RESEARCH_MAX_COMPETITORS } from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseId, parseProjectId } from './utils.js';
import {
  readCompetitorResearchRun,
  readCurrentCompetitorDiscovery,
  readCurrentCompetitorGap,
  startCompetitorDiscovery,
  startCompetitorGap,
} from '../../services/competitorResearchService.js';

export const competitorResearchRouter: Router = Router({ mergeParams: true });

competitorResearchRouter.use(requireAuth);

const domainField = z.string().trim().max(COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS).optional();

const discoverySchema = z.object({
  domain: domainField,
  refresh: z.boolean().optional(),
});

const gapSchema = z.object({
  domain: domainField,
  competitors: z
    .array(z.string().trim().min(1).max(COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS))
    .min(1)
    .max(COMPETITOR_RESEARCH_MAX_COMPETITORS),
  refresh: z.boolean().optional(),
});

const gapSnapshotQuerySchema = z.object({
  domain: domainField,
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
});

/** Start domain-based competitor discovery for the project's domain. */
competitorResearchRouter.post(
  '/competitors',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = discoverySchema.parse(req.body);
    const run = await startCompetitorDiscovery(container, projectId, user!.sub, body.domain, {
      refresh: body.refresh,
    });
    res.status(202).json({ data: run });
  }),
);

/** Read the current discovery snapshot for the project, or null when none. */
competitorResearchRouter.get(
  '/competitors/snapshot',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
    const snapshot = await readCurrentCompetitorDiscovery(container, projectId, domain);
    res.json({ data: snapshot });
  }),
);

/** Start a keyword-gap analysis for the selected competitors. */
competitorResearchRouter.post(
  '/competitor-gap',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = gapSchema.parse(req.body);
    const run = await startCompetitorGap(container, projectId, user!.sub, body.domain, body.competitors, {
      refresh: body.refresh,
    });
    res.status(202).json({ data: run });
  }),
);

/** Read the current gap snapshot for a competitor set, or null when none. */
competitorResearchRouter.get(
  '/competitor-gap/snapshot',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const query = gapSnapshotQuerySchema.parse(req.query);
    const snapshot = await readCurrentCompetitorGap(container, projectId, query.domain, query.competitors);
    res.json({ data: snapshot });
  }),
);

/** Read one specific competitor research run by its job id. */
competitorResearchRouter.get(
  '/competitors/:jobId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const jobId = parseId(req, 'jobId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const run = await readCompetitorResearchRun(container, projectId, jobId);
    res.json({ data: run });
  }),
);
