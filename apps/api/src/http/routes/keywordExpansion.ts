/**
 * Keyword expansion API (KW4). Mounted at /api/projects/:projectId/keyword.
 *
 * POST /expansion              - start one discover -> review expansion run (editor+)
 * GET  /expansion/:jobId       - read exactly that run's bounded snapshot (viewer+)
 * POST /expansion/:jobId/save  - explicitly save a verified selection (editor+)
 *
 * Expansion runs on the SAME `dataforseo_keyword_research` job type as KW2; the
 * executor branches on the explicit `methods` array. The route is a thin edge:
 * it validates input, enforces project access/role and delegates to
 * keywordExpansionService. The browser never talks to DataForSEO, never sees
 * provider credentials and never supplies provenance for a save.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  KEYWORD_EXPANSION_MAX_LIMIT_PER_METHOD,
  KEYWORD_EXPANSION_MAX_RESULTS,
  KEYWORD_EXPANSION_MAX_SEEDS,
  KEYWORD_EXPANSION_SEED_MAX_CHARS,
} from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseId, parseProjectId } from './utils.js';
import {
  readKeywordExpansionRun,
  saveKeywordExpansionSelection,
  startKeywordExpansion,
} from '../../services/keywordExpansionService.js';

export const keywordExpansionRouter: Router = Router({ mergeParams: true });

keywordExpansionRouter.use(requireAuth);

const methodSchema = z.enum(['suggestions', 'related', 'ideas']);

const startSchema = z.object({
  seeds: z.array(z.string().trim().min(1).max(KEYWORD_EXPANSION_SEED_MAX_CHARS)).min(1).max(KEYWORD_EXPANSION_MAX_SEEDS),
  methods: z.array(methodSchema).min(1),
  providerMinVolume: z.number().int().nonnegative().optional(),
  relatedDepth: z.number().int().min(0).max(4).optional(),
  limitPerMethod: z.number().int().min(1).max(KEYWORD_EXPANSION_MAX_LIMIT_PER_METHOD).optional(),
});

const querySchema = z.object({
  minVolume: z.coerce.number().nonnegative().optional(),
  method: methodSchema.optional(),
  sort: z.enum(['volume_desc', 'volume_asc', 'keyword_asc']).optional(),
});

const saveSchema = z.object({
  keywords: z.array(z.string().trim().min(1)).min(1).max(KEYWORD_EXPANSION_MAX_RESULTS),
});

/** Start one expansion run for the given seeds and methods. */
keywordExpansionRouter.post(
  '/expansion',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = startSchema.parse(req.body);
    const run = await startKeywordExpansion(container, projectId, user!.sub, body);
    res.status(202).json({ data: run });
  }),
);

/** Read one specific expansion run snapshot, optionally narrowed for display. */
keywordExpansionRouter.get(
  '/expansion/:jobId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const jobId = parseId(req, 'jobId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const query = querySchema.parse(req.query);
    const run = await readKeywordExpansionRun(container, projectId, jobId, query);
    res.json({ data: run });
  }),
);

/** Explicitly save a verified selection of this run's candidates. */
keywordExpansionRouter.post(
  '/expansion/:jobId/save',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const jobId = parseId(req, 'jobId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = saveSchema.parse(req.body);
    const result = await saveKeywordExpansionSelection(container, projectId, jobId, body.keywords);
    res.status(201).json({ data: result });
  }),
);
