/**
 * Project GSC Settings (Stage 4): state + attach/unlink of an account-level
 * Google Search Console property to THIS project.
 *
 * The Google connection and the property registry are owned by the account;
 * a project only links a registry property (seo_project_properties) and keeps a
 * project-scoped data source so jobs + the dashboard stay project-scoped.
 *
 * Mounted at /api/projects/:projectId/gsc. Session-authenticated: the state
 * view is available to viewers (so the UI can decide what to show), attach and
 * unlink are editor+ (they mutate the project's data source and link rows).
 * Endpoints are thin - every decision (which integration backs the account,
 * whether the property already exists, what the data source upsert must look
 * like) is resolved here against the account registry, not hardcoded in the UI.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseProjectId } from './utils.js';
import { googleConnectionState, registryProperties } from '../../services/accountService.js';
import type { GscRegistryPropertyDto } from '@seo/contracts';

export const projectGscRouter: Router = Router({ mergeParams: true });

projectGscRouter.use(requireAuth);

type Container = ReturnType<typeof import('../../context.js').getContainer>;

type Row = Record<string, unknown>;

/** Read the project row itself; used to resolve which account owns it. */
async function projectRow(container: Container, projectId: string) {
  const { data, error } = await container.sb.from('seo_projects').select('id, name, account_id').eq('id', projectId).maybeSingle();
  if (error) throw new ApiError(500, 'storage_error', 'Could not read the project');
  return data as Row | null;
}

/**
 * The account's connected GSC integration (project_id NULL since Stage 4 moved
 * the Google connection to account scope). Only this single row can back a
 * project attach - there is no per-project Google credential anymore.
 */
async function connectedAccountIntegration(container: Container, accountId: string) {
  const { data, error } = await container.sb
    .from('seo_integrations')
    .select('*')
    .eq('account_id', accountId)
    .is('project_id', null)
    .eq('provider_type', 'gsc')
    .eq('status', 'connected')
    .maybeSingle();
  if (error) throw new ApiError(500, 'storage_error', 'Could not read the Google connection');
  return data as Row | null;
}

// ---------------------------------------------------------------------------
// GET /state - connection state + current link + attach candidates
// ---------------------------------------------------------------------------

/**
 * GET /state - aggregate the account connection state, this project's current
 * linked property and the registry candidates not yet claimed by another
 * project. Callers read a single payload instead of three tables.
 */
projectGscRouter.get(
  '/state',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const project = await projectRow(container, projectId);
    if (!project) throw ApiError.notFound('Project not found');
    const accountId = project.account_id as string | null;

    let google;
    let candidates: GscRegistryPropertyDto[] = [];
    if (accountId) {
      google = await googleConnectionState(container.sb, accountId);
      const registry = await registryProperties(container.sb, accountId);
      candidates = registry.filter((r) => !r.linked_project || r.linked_project.id === projectId);
    } else {
      google = { connected: false, integration_id: null, status: null, last_sync_at: null, error: null };
    }

    const { data: links } = await container.sb
      .from('seo_project_properties')
      .select('property_id, is_primary')
      .eq('project_id', projectId)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    let current = null;
    if (links) {
      const { data: property } = await container.sb
        .from('seo_gsc_properties')
        .select('id, site_url')
        .eq('id', links.property_id as string)
        .maybeSingle();
      if (property) {
        current = {
          property_id: property.id as string,
          site_url: property.site_url as string,
          is_primary: Boolean(links.is_primary),
        };
      }
    }

    res.json({ data: { google, current, candidates } });
  }),
);

// ---------------------------------------------------------------------------
// POST /attach - link an account registry property (or register a newly
// discovered site) to this project.
// ---------------------------------------------------------------------------

/**
 * POST /attach - point this project at a Search Console property. Attaching is
 * idempotent per (project, site_url): it upserts the registry row when the
 * caller only has a siteUrl, upserts the project-scoped data source bound to
 * the account integration, marks the property primary on this project and
 * clears the primary flag on any previous link. Fails loudly when there is no
 * account or no connected account-level GSC integration.
 */
projectGscRouter.post(
  '/attach',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');

    const body = z
      .object({ property_id: z.string().uuid().optional(), siteUrl: z.string().min(1).optional(), name: z.string().optional() })
      .parse(req.body);
    if (!body.property_id && !body.siteUrl) {
      throw ApiError.badRequest('Provide an existing property_id or a siteUrl to register');
    }

    const project = await projectRow(container, projectId);
    if (!project) throw ApiError.notFound('Project not found');
    const accountId = project.account_id as string | null;
    if (!accountId) throw ApiError.conflict('This project has no account');

    const integration = await connectedAccountIntegration(container, accountId);
    if (!integration) throw ApiError.badRequest('Connect Google Search Console to your account first');

    // Resolve (and register, when discovering) the registry property.
    let property: Row;
    if (body.property_id) {
      const { data, error } = await container.sb
        .from('seo_gsc_properties')
        .select('*')
        .eq('id', body.property_id)
        .eq('account_id', accountId)
        .maybeSingle();
      if (error) throw new ApiError(500, 'storage_error', 'Could not read the property');
      if (!data) throw ApiError.notFound('Property not found in your account registry');
      property = data as Row;
    } else {
      const siteUrl = body.siteUrl!;
      const { data, error } = await container.sb
        .from('seo_gsc_properties')
        .upsert(
          {
            account_id: accountId,
            integration_id: integration.id as string,
            site_url: siteUrl,
            is_active: true,
          } as never,
          { onConflict: 'account_id,site_url' },
        )
        .select()
        .single();
      if (error) throw ApiError.badRequest(`Could not register property: ${error.message}`);
      property = data as Row;
    }
    const propertyId = property.id as string;
    const siteUrl = property.site_url as string;
    const descriptor = container.registry.listDataSources().find((d) => d.id === 'gsc');

    // Project-scoped data source bound to the account integration (the worker
    // resolves tokens through this integration and the site through the link).
    const { data: ds, error: dsError } = await container.sb
      .from('seo_data_sources')
      .upsert(
        {
          project_id: projectId,
          integration_id: integration.id as string,
          provider_type: 'gsc',
          kind: 'gsc_property',
          name: body.name ?? siteUrl,
          status: 'active',
          external_id: siteUrl,
          external_url: siteUrl,
          config: { siteUrl },
          capabilities: descriptor?.capabilities ?? [],
        } as never,
        { onConflict: 'project_id,provider_type,external_id' },
      )
      .select()
      .single();
    if (dsError) throw ApiError.badRequest(`Could not attach property: ${dsError.message}`);

    // Link the property to this project (making it primary).
    const { error: linkError } = await container.sb
      .from('seo_project_properties')
      .upsert(
        { project_id: projectId, property_id: propertyId, is_primary: true } as never,
        { onConflict: 'project_id,property_id' },
      );
    if (linkError) {
      if (String(linkError.code) === '23505') {
        throw ApiError.conflict('This property is already attached to another project');
      }
      throw ApiError.badRequest(`Could not link property: ${linkError.message}`);
    }
    await container.sb
      .from('seo_project_properties')
      .update({ is_primary: false })
      .eq('project_id', projectId)
      .neq('property_id', propertyId);
    await container.sb.from('seo_integrations').update({ status: 'connected', config: { site_url: siteUrl } }).eq('id', integration.id as string);

    res.status(201).json({ data: { dataSource: ds, property } });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /attach - unlink the property from this project (registry row and the
// account connection stay intact; the data source is deactivated).
// ---------------------------------------------------------------------------

/**
 * DELETE /attach - unlink the current (or a given) property from this project.
 * The account registry row and connection deliberately stay intact so the same
 * property can be re-attached later; only the project link is removed and the
 * project-scoped data source is flipped to 'inactive' so sync jobs stop
 * resolving a detached site.
 */
projectGscRouter.delete(
  '/attach',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');

    const body = z.object({ property_id: z.string().uuid().optional() }).parse(req.body ?? {});
    let propertyId = body.property_id ?? null;
    if (!propertyId) {
      const { data: link } = await container.sb
        .from('seo_project_properties')
        .select('property_id')
        .eq('project_id', projectId)
        .order('is_primary', { ascending: false })
        .limit(1)
        .maybeSingle();
      propertyId = (link as Row | null)?.property_id as string | null;
    }
    if (!propertyId) throw ApiError.badRequest('No property is attached to this project');

    const { data: property } = await container.sb
      .from('seo_gsc_properties')
      .select('id, site_url')
      .eq('id', propertyId)
      .maybeSingle();
    const siteUrl = (property as Row | null)?.site_url as string | null;

    const { error: delError } = await container.sb
      .from('seo_project_properties')
      .delete()
      .eq('project_id', projectId)
      .eq('property_id', propertyId);
    if (delError) throw new ApiError(500, 'storage_error', 'Could not unlink the property');

    if (siteUrl) {
      await container.sb
        .from('seo_data_sources')
        .update({ status: 'inactive' })
        .eq('project_id', projectId)
        .eq('provider_type', 'gsc')
        .eq('external_id', siteUrl);
    }

    res.json({ data: { ok: true } });
  }),
);
