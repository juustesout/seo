/**
 * Usage read API (R5.10.8).
 *
 * The read surface over the append-only usage ledger: project-scoped at
 * /api/projects/:projectId/usage and account-scoped at /api/account/usage.
 * Both return the same stable `UsageReportDto` (scope + aggregate totals) so the
 * web view and future MCP tools share one shape. This is a reporting surface,
 * never a second accounting system: it aggregates existing facts (no schema,
 * vocabulary, pricing or cost), and it uses the existing authorization path -
 * per-project `requireRole` for a project, `requireAccount` for the caller's own
 * account. Raw events are never returned.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  USAGE_CATEGORIES,
  USAGE_OPERATION_MAX_CHARS,
  USAGE_PROVIDER_MAX_CHARS,
  USAGE_UNITS,
} from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseProjectId } from './utils.js';
import { readUsageReport, type UsageReportRequest } from '../../services/usageReportService.js';

/**
 * Shared read filter. Category/unit are the closed vocabulary; provider and
 * operation are bounded tokens (never free-form); success is an explicit
 * true/false; the window is a UTC instant range (`occurredFrom` inclusive,
 * `occurredTo` exclusive, matching the store). No scope, pagination or raw-event
 * parameters are accepted - the surface is aggregates only.
 */
const usageQuerySchema = z.object({
  category: z.enum(USAGE_CATEGORIES).optional(),
  provider: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'Invalid provider')
    .max(USAGE_PROVIDER_MAX_CHARS)
    .optional(),
  operation: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'Invalid operation')
    .max(USAGE_OPERATION_MAX_CHARS)
    .optional(),
  unit: z.enum(USAGE_UNITS).optional(),
  success: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  occurredFrom: z.string().datetime().optional(),
  occurredTo: z.string().datetime().optional(),
});

type UsageQuery = Omit<UsageReportRequest, 'actorUserId' | 'accountId' | 'projectId'>;

function parseUsageQuery(raw: unknown): UsageQuery {
  return usageQuerySchema.parse(raw);
}

export const usageRouter: Router = Router({ mergeParams: true });
usageRouter.use(requireAuth);

/** Project usage: any member (viewer+) may read the project's own consumption. */
usageRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const filter = parseUsageQuery(req.query);
    const report = await readUsageReport(container.usageEvents, {
      actorUserId: user!.sub,
      projectId,
      ...filter,
    });
    res.json({ data: report });
  }),
);

export const accountUsageRouter: Router = Router();
accountUsageRouter.use(requireAuth);

/** Account usage: the caller's own account only (never an account id from the URL). */
accountUsageRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    const { account_id: accountId } = await container.access.requireAccount(user!.sub);
    const filter = parseUsageQuery(req.query);
    const report = await readUsageReport(container.usageEvents, {
      actorUserId: user!.sub,
      accountId,
      ...filter,
    });
    res.json({ data: report });
  }),
);
