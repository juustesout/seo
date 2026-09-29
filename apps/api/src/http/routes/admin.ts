/**
 * Platform administration API (P3).
 *
 * Read-only operational views for the Old Skool SEO operator. This is NOT
 * project administration: authorization goes through the single
 * `container.access.requirePlatformAdmin(user.sub)` primitive, which checks the
 * server-only platform-admin registry - a project owner/admin is not a platform
 * admin unless their user id is registered. The router-level guard runs before
 * every handler, so no admin response can be produced without it, and the
 * service-role database functions re-verify the same actor (defense in depth).
 *
 * Nothing here returns secrets: no tokens, credentials, API key material or job
 * payloads. The usage read reuses the existing append-only ledger aggregate.
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

export const adminRouter: Router = Router();

adminRouter.use(requireAuth);

/**
 * The one platform-admin gate for the whole surface. `next()` is called after
 * the await so a rejection is caught by asyncHandler and never reaches a
 * handler.
 */
adminRouter.use(
  asyncHandler(async (req, _res, next) => {
    await req.container.access.requirePlatformAdmin(req.user!.sub);
    next();
  }),
);

adminRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const data = await req.container.platformAdmin.overview(req.user!.sub);
    res.json({ data });
  }),
);

adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const data = await req.container.platformAdmin.listUsers(req.user!.sub);
    res.json({ data });
  }),
);

adminRouter.get(
  '/accounts',
  asyncHandler(async (req, res) => {
    const data = await req.container.platformAdmin.listAccounts(req.user!.sub);
    res.json({ data });
  }),
);

adminRouter.get(
  '/projects',
  asyncHandler(async (req, res) => {
    const data = await req.container.platformAdmin.listProjects(req.user!.sub);
    res.json({ data });
  }),
);

/**
 * Cross-account usage query. Same bounded token vocabulary as the customer
 * usage read (no free-form provider/operation), plus optional account/project
 * uuid filters. Filtering is read-only and cannot change the ledger.
 */
const adminUsageQuerySchema = z.object({
  accountId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
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

adminRouter.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const filter = adminUsageQuerySchema.parse(req.query);
    const data = await req.container.platformAdmin.usage(req.user!.sub, filter);
    res.json({ data });
  }),
);
