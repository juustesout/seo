/**
 * Account API (Stage 4): account-scoped Google Search Console connect, the
 * property registry and the cross-project overview/account home payloads.
 *
 * Mounted at /api/account. Everything here resolves under the caller's own
 * account (one user = one account); provider secrets never leave the server.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { buildProviderContext } from '../../context.js';
import { redirectBase } from './utils.js';
import { buildAuthorizationUrl, signState } from '../../providers/gsc/oauth.js';
import { GscDataSource } from '../../providers/gsc/gscDataSource.js';
import { logger } from '../../logger.js';
import {
  accountProjectIds,
  aggregateAccountMetrics,
  buildAccountProjects,
  googleConnectionState,
  recentAccountActivity,
  registryProperties,
} from '../../services/accountService.js';

export const accountRouter: Router = Router();

accountRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Container = ReturnType<typeof import('../../context.js').getContainer>;

async function accountRow(container: Container, accountId: string) {
  const { data, error } = await container.sb.from('seo_accounts').select('id, name, created_at').eq('id', accountId).maybeSingle();
  if (error) throw new ApiError(500, 'storage_error', 'Could not read account');
  if (!data) throw ApiError.notFound('Account not found');
  return data as unknown as { id: string; name: string; created_at: string };
}

async function requireAccount(container: Container, userId: string) {
  return container.access.requireAccount(userId);
}

function requireConfigured(flag: boolean, label: string) {
  if (!flag) throw ApiError.notConfigured(`${label} is not configured on the server`);
}

function requireKey(container: Container): string {
  const key = container.config.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!key) throw ApiError.notConfigured('Credential storage key is missing');
  return key;
}

async function requireConnectedGscIntegration(container: Container, accountId: string) {
  const { data, error } = await container.sb
    .from('seo_integrations')
    .select('*')
    .eq('account_id', accountId)
    .is('project_id', null)
    .eq('provider_type', 'gsc')
    .eq('status', 'connected')
    .maybeSingle();
  if (error) throw new ApiError(500, 'storage_error', 'Could not read the Google connection');
  if (!data) throw ApiError.badRequest('Connect Google Search Console first');
  return data as Record<string, unknown>;
}

function gscContext(container: Container, integration: Record<string, unknown>, userId: string) {
  return buildProviderContext(container, {
    projectId: String(integration.project_id ?? ''),
    userId,
    owner: { integrationId: String(integration.id), providerType: 'gsc' },
    config: (integration.config as Record<string, unknown>) ?? {},
  });
}

async function attachedProjectCount(container: Container, accountId: string): Promise<number> {
  const projectIds = await accountProjectIds(container.sb, accountId);
  if (projectIds.length === 0) return 0;
  const { count } = await container.sb
    .from('seo_project_properties')
    .select('id', { count: 'exact', head: true })
    .in('project_id', projectIds);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Account home
// ---------------------------------------------------------------------------

accountRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    const { account_id: accountId } = await requireAccount(container, user!.sub);

    const [account, google, projects, registry] = await Promise.all([
      accountRow(container, accountId),
      googleConnectionState(container.sb, accountId),
      buildAccountProjects(container.sb, user!.sub, accountId),
      registryProperties(container.sb, accountId),
    ]);

    const projectNames = new Map(projects.map((p) => [p.id, p.name]));
    const recentActivity = await recentAccountActivity(container.sb, projects.map((p) => p.id), projectNames);

    res.json({
      data: {
        account,
        google,
        registry_count: registry.length,
        attached_projects: projects.filter((p) => p.property).length,
        projects,
        recent_activity: recentActivity,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Google Search Console connect (account level)
// ---------------------------------------------------------------------------

accountRouter.get(
  '/gsc/connect-url',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    const { account_id: accountId } = await requireAccount(container, user!.sub);

    requireConfigured(container.config.googleConfigured, 'Google OAuth');
    requireConfigured(container.config.encryptionConfigured, 'Credential storage');

    // Reuse any existing account-scoped GSC integration (any status) so a
    // re-connect keeps the same token owner and registry links intact.
    let integrationId: string | null = null;
    const existing = await container.sb
      .from('seo_integrations')
      .select('id')
      .eq('account_id', accountId)
      .is('project_id', null)
      .eq('provider_type', 'gsc')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    integrationId = (existing.data as { id: string } | null)?.id ?? null;

    if (!integrationId) {
      const insert = await container.sb
        .from('seo_integrations')
        .insert({
          account_id: accountId,
          project_id: null,
          provider_type: 'gsc',
          name: 'Google Search Console',
          status: 'disconnected',
          capabilities: container.registry.listDataSources().find((d) => d.id === 'gsc')?.capabilities ?? [],
          config: {},
          created_by: user!.sub,
        } as never)
        .select()
        .single();
      if (insert.error) throw new ApiError(500, 'storage_error', 'Could not create the Google connection');
      integrationId = (insert.data as { id: string }).id;
    }

    // Mark connecting so the account-level "one active per provider" guard
    // applies while the user completes consent.
    await container.sb.from('seo_integrations').update({ status: 'connecting', last_error: null }).eq('id', integrationId);

    const state = signState(
      { accountId, integrationId, userId: user!.sub, nonce: crypto.randomUUID() },
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

/** Account property registry: every Search Console property the account holds. */
accountRouter.get(
  '/gsc/registry',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    const { account_id: accountId } = await requireAccount(container, user!.sub);
    const registry = await registryProperties(container.sb, accountId);
    res.json({ data: { properties: registry } });
  }),
);

/** Live discovery of the Search Console properties the connected account sees. */
accountRouter.get(
  '/gsc/discover',
  asyncHandler(async (req, res) => {    const { container, user } = req;
    const { account_id: accountId } = await requireAccount(container, user!.sub);
    const integration = await requireConnectedGscIntegration(container, accountId);

    const adapter = container.registry.getDataSource('gsc') as GscDataSource | undefined;
    if (!adapter) throw ApiError.notConfigured('GSC provider is not registered');
    const ctx = gscContext(container, integration, user!.sub);
    const properties = await adapter.listProperties(ctx);

    const registered = await registryProperties(container.sb, accountId);
    const registeredSites = new Set(registered.map((r) => r.site_url));

    res.json({
      data: {
        properties: properties.map((p) => ({ ...p, already_registered: registeredSites.has(p.siteUrl) })),
      },
    });
  }),
);

/** Disconnect Google: drop stored tokens and mark the integration disconnected. */
accountRouter.post(
  '/gsc/disconnect',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    const { account_id: accountId } = await requireAccount(container, user!.sub);
    const { data } = await container.sb
      .from('seo_integrations')
      .select('*')
      .eq('account_id', accountId)
      .is('project_id', null)
      .eq('provider_type', 'gsc')
      .maybeSingle();
    if (!data) {
      res.json({ data: { ok: true, was_connected: false } });
      return;
    }
    const integration = data as Record<string, unknown>;
    const adapter = container.registry.getDataSource('gsc') as GscDataSource | undefined;
    if (adapter) {
      const ctx = gscContext(container, integration, user!.sub);
      try {
        await adapter.disconnect(ctx);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'gsc disconnect token cleanup failed');
      }
    }
    await container.sb.from('seo_integrations').update({ status: 'disconnected', last_error: null }).eq('id', integration.id as string);
    res.json({ data: { ok: true, was_connected: true } });
  }),
);

// ---------------------------------------------------------------------------
// Account overview (adaptive Overall Dashboard / Account Home)
// ---------------------------------------------------------------------------

accountRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    const { account_id: accountId } = await requireAccount(container, user!.sub);
    const days = z.coerce.number().int().min(1).max(365).default(28).parse(req.query.days ?? 28);

    const [google, registry] = await Promise.all([
      googleConnectionState(container.sb, accountId),
      registryProperties(container.sb, accountId),
    ]);
    const attachedCount = await attachedProjectCount(container, accountId);

    const ready = google.connected && registry.length > 0 && attachedCount > 0;
    const metrics = ready ? await aggregateAccountMetrics(container.sb, accountId, days) : null;

    res.json({
      data: {
        connected: google.connected,
        registry_count: registry.length,
        attached_count: attachedCount,
        totals: metrics?.totals ?? null,
        series: metrics?.series ?? null,
        properties: metrics?.properties ?? null,
      },
    });
  }),
);
