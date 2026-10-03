/**
 * Project Ads API (P5): bind THIS project to one account-level Google Ads
 * customer and read its paid search intelligence.
 *
 * The Google Ads authorization is owned by the account (a separate
 * account-scoped 'ads' integration); a project only stores the Google Ads
 * customer reference it reads from (seo_project_ads). Every route authorizes
 * the caller against the project, and the service re-validates any customer id
 * against the account's live Google metadata - so a client can never point a
 * project at an arbitrary Google Ads customer or read another project's binding.
 *
 * Mounted at /api/projects/:projectId/ads. Session-authenticated: state and the
 * report are viewer+; selecting/clearing the customer requires the admin role
 * (project administrator/owner), mirroring the account-level ownership of the
 * Google connection. All reads are read-only by construction.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseProjectId } from './utils.js';
import { GoogleAdsService, resolveAdsPeriodDays } from '../../services/googleAdsService.js';
import type { ProjectAdsStateDto } from '@seo/contracts';

export const projectAdsRouter: Router = Router({ mergeParams: true });

projectAdsRouter.use(requireAuth);

type Container = ReturnType<typeof import('../../context.js').getContainer>;

/** Read the project's owning account id; the account is the Ads authorization scope. */
async function projectAccountId(container: Container, projectId: string): Promise<string | null> {
  const { data, error } = await container.sb.from('seo_projects').select('account_id').eq('id', projectId).maybeSingle();
  if (error) throw new ApiError(500, 'storage_error', 'Could not read the project');
  if (!data) throw ApiError.notFound('Project not found');
  return (data as { account_id: string | null }).account_id;
}

// ---------------------------------------------------------------------------
// GET /state - cheap Ads state for Settings (no live Google call)
// ---------------------------------------------------------------------------

/**
 * Connection state, the project's bound customer and whether the caller may
 * change it. Deliberately does not call Google: the Settings panel loads fast,
 * and customer discovery is a separate explicit request.
 */
projectAdsRouter.get(
  '/state',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    const access = await container.access.requireRole(user!.sub, projectId, 'viewer');
    const accountId = await projectAccountId(container, projectId);
    const service = new GoogleAdsService(container);

    const google = accountId
      ? await service.connectionState(accountId)
      : { connected: false, integration_id: null, status: null, account_email: null, error: null };
    const current = await service.currentCustomer(projectId);

    const data: ProjectAdsStateDto = {
      google,
      current,
      can_manage: access.role === 'owner' || access.role === 'admin',
    };
    res.json({ data });
  }),
);

// ---------------------------------------------------------------------------
// GET /customers - live discovery of the account's Google Ads customers
// ---------------------------------------------------------------------------

/**
 * Live Google Ads customer discovery for the account's authorization. Viewer+
 * (the customer list is not a secret: it only reveals customers the account can
 * already reach). Returns an empty list when Google reports none.
 */
projectAdsRouter.get(
  '/customers',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const accountId = await projectAccountId(container, projectId);
    if (!accountId) throw ApiError.conflict('This project has no account');

    const service = new GoogleAdsService(container);
    const [google, customers] = await Promise.all([service.connectionState(accountId), service.listCustomers(accountId)]);
    res.json({ data: { google, customers } });
  }),
);

// ---------------------------------------------------------------------------
// PUT /customer - select (or replace) the project's Google Ads customer
// ---------------------------------------------------------------------------

/**
 * Bind the project to a Google Ads customer. Admin+ only. The customer id is
 * re-validated against the account's live Google metadata (the authoritative
 * name, currency and manager flag come from Google, never from the request
 * body).
 */
projectAdsRouter.put(
  '/customer',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const body = z.object({ customer_id: z.string().min(1) }).parse(req.body);

    const accountId = await projectAccountId(container, projectId);
    if (!accountId) throw ApiError.conflict('This project has no account');

    const service = new GoogleAdsService(container);
    const customer = await service.selectCustomer({
      accountId,
      projectId,
      userId: user!.sub,
      customerId: body.customer_id,
    });
    res.json({ data: { customer } });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /customer - clear the project's Ads binding (account stays)
// ---------------------------------------------------------------------------

/** Remove this project's Google Ads binding. Admin+ only; the account connection is untouched. */
projectAdsRouter.delete(
  '/customer',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    await new GoogleAdsService(container).clearCustomer(projectId);
    res.json({ data: { ok: true } });
  }),
);

// ---------------------------------------------------------------------------
// GET /report - normalized paid search intelligence for the bound customer
// ---------------------------------------------------------------------------

/**
 * Search-term and keyword report over the selected period (default: last 28
 * days). Reads the account's Ads tokens server-side (refreshing once when
 * expired) and returns the normalized DTO - never a raw Google response. A
 * project with no bound customer gets an empty report with `customer: null` so
 * the UI can prompt for a customer instead of treating it as an error.
 */
projectAdsRouter.get(
  '/report',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const days = resolveAdsPeriodDays(req.query.days ?? 28);
    const filter = typeof req.query.filter === 'string' ? req.query.filter : null;
    const accountId = await projectAccountId(container, projectId);
    if (!accountId) throw ApiError.conflict('This project has no account');

    const report = await new GoogleAdsService(container).report({ accountId, projectId, days, filter, userId: user!.sub });
    res.json({ data: report });
  }),
);
