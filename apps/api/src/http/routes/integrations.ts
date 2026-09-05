/**
 * Integrations API (project-scoped). All provider secrets stay server-side:
 * OAuth codes are exchanged here, tokens are stored encrypted, and the browser
 * only ever sees provider *capability* state.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { buildProviderContext } from '../../context.js';
import { parseId, parseProjectId, redirectBase } from './utils.js';
import { signState, buildAuthorizationUrl } from '../../providers/gsc/oauth.js';
import { GscDataSource } from '../../providers/gsc/gscDataSource.js';
import { DATAFORSEO_CRED_KEYS } from '../../providers/dataforseo/dataSource.js';

export const integrationsRouter: Router = Router({ mergeParams: true });

integrationsRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function loadIntegration(container: ReturnType<typeof import('../../context.js').getContainer>, projectId: string, integrationId: string) {
  const { data } = await container.sb
    .from('seo_integrations')
    .select('*')
    .eq('project_id', projectId)
    .eq('id', integrationId)
    .maybeSingle();
  if (!data) throw ApiError.notFound('Integration not found for this project');
  return data as Record<string, unknown>;
}

function descriptorFor(container: ReturnType<typeof import('../../context.js').getContainer>, id: string) {
  const d = container.registry.listDataSources().find((ds) => ds.id === id);
  return d ?? null;
}

function nonSecretConfig(integration: Record<string, unknown>): Record<string, unknown> {
  return {
    provider_type: integration.provider_type,
    name: integration.name,
    capabilities: integration.capabilities,
    // intentionally excludes the config object (may hold property ids only,
    // never secrets) - keep it minimal for the browser
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Create a new (disconnected) integration of a registered provider. */
integrationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');

    const body = z
      .object({ provider_type: z.string().min(1), name: z.string().optional() })
      .parse(req.body);
    const descriptor = descriptorFor(container, body.provider_type);
    if (!descriptor) throw ApiError.badRequest(`Unknown provider type: ${body.provider_type}`);

    const { data, error } = await container.sb
      .from('seo_integrations')
      .insert({
        project_id: projectId,
        provider_type: body.provider_type,
        name: body.name ?? descriptor.name,
        status: 'disconnected',
        capabilities: descriptor.capabilities,
        config: {},
        created_by: user!.sub,
      })
      .select()
      .single();
    if (error) {
      if (String(error.message).toLowerCase().includes('duplicate')) {
        throw ApiError.conflict(`A ${descriptor.name} integration already exists for this project`);
      }
      throw ApiError.badRequest('Could not create integration');
    }
    res.status(201).json({ data: { integration: data, descriptor, secret_free_config: nonSecretConfig(data as Record<string, unknown>) } });
  }),
);

/** Integration list with descriptors merged in. */
integrationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const { data } = await container.sb
      .from('seo_integrations')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    res.json({
      data: (data ?? []).map((i) => ({
        integration: i,
        descriptor: descriptorFor(container, (i as Record<string, unknown>).provider_type as string),
      })),
    });
  }),
);

integrationsRouter.get(
  '/:integrationId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const integrationId = parseId(req, 'integrationId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const integration = await loadIntegration(container, projectId, integrationId);
    res.json({ data: { integration, descriptor: descriptorFor(container, integration.provider_type as string) } });
  }),
);

/** Store an integration credential (browser sends value once over TLS). */
integrationsRouter.post(
  '/:integrationId/credentials',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const integrationId = parseId(req, 'integrationId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const integration = await loadIntegration(container, projectId, integrationId);
    const body = z.object({ key: z.string().min(1), value: z.string().min(1) }).parse(req.body);

    const allowed: Record<string, string[]> = {
      dataforseo: [DATAFORSEO_CRED_KEYS.login, DATAFORSEO_CRED_KEYS.password],
    };
    const provider = integration.provider_type as string;
    const keys = allowed[provider];
    if (!keys || !keys.includes(body.key)) {
      throw ApiError.badRequest(`Credential key '${body.key}' is not allowed for provider '${provider}'`);
    }
    if (!container.config.encryptionConfigured) {
      throw ApiError.notConfigured('Credential storage is not configured (CREDENTIALS_ENCRYPTION_KEY)');
    }
    await container.credentials.reader({ integrationId }, provider).set(body.key, body.value);
    res.json({ data: { ok: true } });
  }),
);

/** Test a connection; flips status to connected on success. */
integrationsRouter.post(
  '/:integrationId/test',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const integrationId = parseId(req, 'integrationId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const integration = await loadIntegration(container, projectId, integrationId);
    const providerType = integration.provider_type as string;
    const adapter = container.registry.getDataSource(providerType);
    if (!adapter) throw ApiError.badRequest(`No adapter for provider ${providerType}`);

    const ctx = buildProviderContext(container, {
      projectId,
      userId: user!.sub,
      owner: { integrationId, providerType },
      config: (integration.config as Record<string, unknown>) ?? {},
    });
    const result = await adapter.testConnection(ctx);
    if (result.ok) {
      await container.sb
        .from('seo_integrations')
        .update({ status: 'connected', last_error: null })
        .eq('id', integrationId);
      // Non-GSC adapters have no property picker, so create the account-level
      // data source lazily - jobs and the dashboard depend on it existing.
      if (providerType !== 'gsc') {
        await ensureAccountDataSource(container, projectId, integrationId, providerType);
      }
    } else {
      await container.sb.from('seo_integrations').update({ status: 'error' }).eq('id', integrationId);
    }
    res.json({ data: { ...result, status: result.ok ? 'connected' : 'error' } });
  }),
);

/** Disconnect: clear tokens, mark the integration + its data sources inactive. */
integrationsRouter.post(
  '/:integrationId/disconnect',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const integrationId = parseId(req, 'integrationId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const integration = await loadIntegration(container, projectId, integrationId);
    const providerType = integration.provider_type as string;
    const adapter = container.registry.getDataSource(providerType);
    if (adapter) {
      const ctx = buildProviderContext(container, {
        projectId,
        userId: user!.sub,
        owner: { integrationId, providerType },
        config: (integration.config as Record<string, unknown>) ?? {},
      });
      try {
        await adapter.disconnect(ctx);
      } catch (err) {
        // token cleanup is best-effort; still mark disconnected
      }
    }
    await container.credentials.clearForOwner({ integrationId });
    await container.sb.from('seo_integrations').update({ status: 'disconnected', last_error: null }).eq('id', integrationId);
    await container.sb.from('seo_data_sources').update({ status: 'inactive' }).eq('integration_id', integrationId);
    res.json({ data: { ok: true } });
  }),
);

/** Delete integration row entirely (admin). */
integrationsRouter.delete(
  '/:integrationId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const integrationId = parseId(req, 'integrationId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    await loadIntegration(container, projectId, integrationId);
    await container.credentials.clearForOwner({ integrationId });
    await container.sb.from('seo_integrations').delete().eq('project_id', projectId).eq('id', integrationId);
    res.json({ data: { ok: true } });
  }),
);

// ---------------------------------------------------------------------------
// Google Search Console (OAuth + property attach)
// ---------------------------------------------------------------------------

integrationsRouter.get(
  '/:integrationId/oauth-url',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const integrationId = parseId(req, 'integrationId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const integration = await loadIntegration(container, projectId, integrationId);
    if (integration.provider_type !== 'gsc') throw ApiError.badRequest('OAuth flow is only available for Search Console');
    requireConfigured(container.config.googleConfigured, 'Google OAuth');
    requireConfigured(container.config.encryptionConfigured, 'Credential storage');

    const state = signState(
      { projectId, integrationId, userId: user!.sub, nonce: crypto.randomUUID() },
      requireKey(container),
    );
    const redirectUri = `${redirectBase(req)}/api/oauth/gsc/callback`;
    const url = buildAuthorizationUrl({
      clientId: container.config.env.GOOGLE_CLIENT_ID!,
      redirectUri,
      state,
    });
    res.json({ data: { url, redirect_uri: redirectUri } });
  }),
);

/** After OAuth: returns available Search Console properties for selection. */
integrationsRouter.get(
  '/:integrationId/gsc/properties',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const integrationId = parseId(req, 'integrationId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const integration = await loadIntegration(container, projectId, integrationId);
    if (integration.provider_type !== 'gsc') throw ApiError.badRequest('Not a Search Console integration');

    const adapter = container.registry.getDataSource('gsc') as GscDataSource | undefined;
    if (!adapter) throw ApiError.notConfigured('GSC provider not registered');
    const ctx = buildProviderContext(container, {
      projectId,
      userId: user!.sub,
      owner: { integrationId, providerType: 'gsc' },
      config: (integration.config as Record<string, unknown>) ?? {},
    });
    const properties = await adapter.listProperties(ctx);
    res.json({ data: { properties } });
  }),
);

/** Attach a chosen property to the project: data source + property record. */
integrationsRouter.post(
  '/:integrationId/gsc/attach',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const integrationId = parseId(req, 'integrationId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const integration = await loadIntegration(container, projectId, integrationId);
    if (integration.provider_type !== 'gsc') throw ApiError.badRequest('Not a Search Console integration');
    const body = z.object({ siteUrl: z.string().min(1), name: z.string().optional() }).parse(req.body);

    const descriptor = descriptorFor(container, 'gsc')!;
    const accountId = integration.account_id as string | undefined;
    if (!accountId) throw new ApiError(500, 'internal_error', 'GSC integration has no account');

    const { data: property, error: propError } = await container.sb
      .from('seo_gsc_properties')
      .upsert(
        {
          account_id: accountId,
          integration_id: integrationId,
          site_url: body.siteUrl,
          is_active: true,
        } as never,
        { onConflict: 'account_id,site_url' },
      )
      .select()
      .single();
    if (propError) throw ApiError.badRequest(`Could not register property: ${propError.message}`);

    const { data: ds, error: dsError } = await container.sb
      .from('seo_data_sources')
      .upsert(
        {
          project_id: projectId,
          integration_id: integrationId,
          provider_type: 'gsc',
          kind: 'gsc_property',
          name: body.name ?? body.siteUrl,
          status: 'active',
          external_id: body.siteUrl,
          external_url: body.siteUrl,
          config: { siteUrl: body.siteUrl },
          capabilities: descriptor.capabilities,
        } as never,
        { onConflict: 'project_id,provider_type,external_id' },
      )
      .select()
      .single();
    if (dsError) throw ApiError.badRequest(`Could not attach property: ${dsError.message}`);

    const { error: linkError } = await container.sb
      .from('seo_project_properties')
      .upsert(
        {
          project_id: projectId,
          property_id: property.id as string,
          is_primary: true,
        } as never,
        { onConflict: 'project_id,property_id' },
      );
    if (linkError) {
      if (String(linkError.message).includes('duplicate') || String(linkError.code) === '23505') {
        throw ApiError.conflict('This property is already attached to another project');
      }
      throw ApiError.badRequest(`Could not link property: ${linkError.message}`);
    }

    await container.sb
      .from('seo_project_properties')
      .update({ is_primary: false })
      .eq('project_id', projectId)
      .neq('property_id', property.id as string);

    await container.sb
      .from('seo_integrations')
      .update({ status: 'connected', config: { site_url: body.siteUrl } })
      .eq('id', integrationId);

    res.status(201).json({ data: { dataSource: ds, property } });
  }),
);

// ---------------------------------------------------------------------------
// helpers used above
// ---------------------------------------------------------------------------

function requireConfigured(flag: boolean, label: string) {
  if (!flag) throw ApiError.notConfigured(`${label} is not configured on the server`);
}

async function ensureAccountDataSource(
  container: ReturnType<typeof import('../../context.js').getContainer>,
  projectId: string,
  integrationId: string,
  providerType: string,
): Promise<void> {
  const kind = `${providerType}_account`;
  const { data: existing } = await container.sb
    .from('seo_data_sources')
    .select('id')
    .eq('project_id', projectId)
    .eq('provider_type', providerType)
    .eq('kind', kind)
    .maybeSingle();
  if (existing) {
    await container.sb.from('seo_data_sources').update({ status: 'active' }).eq('id', existing.id as string);
    return;
  }
  const descriptor = descriptorFor(container, providerType);
  await container.sb.from('seo_data_sources').insert({
    project_id: projectId,
    integration_id: integrationId,
    provider_type: providerType,
    kind,
    name: descriptor?.name ?? providerType,
    status: 'active',
    config: {},
    capabilities: descriptor?.capabilities ?? [],
  } as never);
}

function requireKey(container: ReturnType<typeof import('../../context.js').getContainer>): string {
  const key = container.config.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!key) throw ApiError.notConfigured('Credential storage key is missing');
  return key;
}
