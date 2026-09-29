/**
 * Project Analytics API (P4): bind THIS project to one account-level GA4
 * property and read its page traffic.
 *
 * The Google Analytics authorization is owned by the account (a separate
 * account-scoped 'ga4' integration); a project only stores the GA4 property
 * reference it reads from (seo_project_analytics). Every route authorizes the
 * caller against the project, and the service re-validates any property id
 * against the account's live Google metadata - so a client can never point a
 * project at an arbitrary Google property or read another project's binding.
 *
 * Mounted at /api/projects/:projectId/analytics. Session-authenticated: state
 * and page traffic are viewer+; selecting/clearing the property requires the
 * admin role (project administrator/owner), mirroring the account-level
 * ownership of the Google connection.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseProjectId } from './utils.js';
import { GoogleAnalyticsService, resolveAnalyticsPeriodDays } from '../../services/googleAnalyticsService.js';
import type { ProjectAnalyticsStateDto } from '@seo/contracts';

export const projectAnalyticsRouter: Router = Router({ mergeParams: true });

projectAnalyticsRouter.use(requireAuth);

type Container = ReturnType<typeof import('../../context.js').getContainer>;

/** Read the project's owning account id; the account is the GA4 authorization scope. */
async function projectAccountId(container: Container, projectId: string): Promise<string | null> {
  const { data, error } = await container.sb.from('seo_projects').select('account_id').eq('id', projectId).maybeSingle();
  if (error) throw new ApiError(500, 'storage_error', 'Could not read the project');
  if (!data) throw ApiError.notFound('Project not found');
  return (data as { account_id: string | null }).account_id;
}

// ---------------------------------------------------------------------------
// GET /state - cheap Analytics state for Settings (no live Google call)
// ---------------------------------------------------------------------------

/**
 * Connection state, the project's bound property and whether the caller may
 * change it. Deliberately does not call Google: the Settings panel loads fast,
 * and property discovery is a separate explicit request.
 */
projectAnalyticsRouter.get(
  '/state',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    const access = await container.access.requireRole(user!.sub, projectId, 'viewer');
    const accountId = await projectAccountId(container, projectId);
    const service = new GoogleAnalyticsService(container);

    const google = accountId
      ? await service.connectionState(accountId)
      : { connected: false, integration_id: null, status: null, account_email: null, error: null };
    const current = await service.currentProperty(projectId);

    const data: ProjectAnalyticsStateDto = {
      google,
      current,
      can_manage: access.role === 'owner' || access.role === 'admin',
    };
    res.json({ data });
  }),
);

// ---------------------------------------------------------------------------
// GET /properties - live discovery of the account's GA4 properties
// ---------------------------------------------------------------------------

/**
 * Live GA4 property discovery for the account's authorization. Viewer+ (the
 * property list is not a secret: it only reveals properties the account can
 * already read). Returns an empty list when Google reports none.
 */
projectAnalyticsRouter.get(
  '/properties',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const accountId = await projectAccountId(container, projectId);
    if (!accountId) throw ApiError.conflict('This project has no account');

    const service = new GoogleAnalyticsService(container);
    const [google, properties] = await Promise.all([service.connectionState(accountId), service.listProperties(accountId)]);
    res.json({ data: { google, properties } });
  }),
);

// ---------------------------------------------------------------------------
// PUT /property - select (or replace) the project's GA4 property
// ---------------------------------------------------------------------------

/**
 * Bind the project to a GA4 property. Admin+ only. The property id is
 * re-validated against the account's live Google metadata (authoritative name
 * and URL come from Google, never from the request body).
 */
projectAnalyticsRouter.put(
  '/property',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const body = z.object({ property_id: z.string().min(1) }).parse(req.body);

    const accountId = await projectAccountId(container, projectId);
    if (!accountId) throw ApiError.conflict('This project has no account');

    const service = new GoogleAnalyticsService(container);
    const property = await service.selectProperty({
      accountId,
      projectId,
      userId: user!.sub,
      propertyId: body.property_id,
    });
    res.json({ data: { property } });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /property - clear the project's Analytics binding (account stays)
// ---------------------------------------------------------------------------

/** Remove this project's GA4 binding. Admin+ only; the account connection is untouched. */
projectAnalyticsRouter.delete(
  '/property',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    await new GoogleAnalyticsService(container).clearProperty(projectId);
    res.json({ data: { ok: true } });
  }),
);

// ---------------------------------------------------------------------------
// GET /page-traffic - normalized page traffic for the bound property
// ---------------------------------------------------------------------------

/**
 * Page-traffic report over the selected period (default: last 28 days). Reads
 * the account's GA4 tokens server-side (refreshing once when expired) and
 * returns the normalized DTO - never a raw Google response. A project with no
 * bound property gets an empty report with `property: null` so the UI can prompt
 * for a property instead of treating it as an error.
 */
projectAnalyticsRouter.get(
  '/page-traffic',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const days = resolveAnalyticsPeriodDays(req.query.days ?? 28);
    const accountId = await projectAccountId(container, projectId);
    if (!accountId) throw ApiError.conflict('This project has no account');

    const report = await new GoogleAnalyticsService(container).pageTraffic({ accountId, projectId, days });
    res.json({ data: report });
  }),
);
