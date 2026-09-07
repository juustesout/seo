/**
 * Publishers API: manage output channels (e.g. WordPress) for a project -
 * create entries, store non-secret config and encrypted credentials, test
 * connections, drive OAuth connects, disconnect and delete.
 *
 * Mounted at /api/projects/:projectId/publishers. Session-authenticated with
 * role gates: viewers list/read, editors configure credentials and test,
 * admins create and delete. "Provider via descriptor" is enforced here, not in
 * the UI: every write key must be declared by the registry descriptor for that
 * provider, and only secrets declared as credentials reach the encrypted
 * CredentialStore. Connection results are persisted to the row so the UI shows
 * real state (honest "error"/"disconnected"), never optimistic status.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { buildPublisherProviderContext } from '../../context.js';
import { publisherOAuthStart } from '../../services/publisherOAuthService.js';
import { parseId, parseProjectId, redirectBase } from './utils.js';

export const publishersRouter: Router = Router({ mergeParams: true });

publishersRouter.use(requireAuth);

/** Keys the descriptor declares as safe to store as config / encrypted credentials. */
function declaredKeys(container: ReturnType<typeof import('../../context.js').getContainer>, provider: string, kind: 'config' | 'credentials'): string[] {
  const descriptor = container.registry.listPublishers().find((p) => p.id === provider);
  const fields = descriptor?.setup?.[kind] ?? [];
  return fields.map((f) => f.key);
}

/** Load a publisher row, failing unless it belongs to this project. */
async function loadPublisher(container: ReturnType<typeof import('../../context.js').getContainer>, projectId: string, publisherId: string) {
  const { data } = await container.sb
    .from('seo_publishers')
    .select('*')
    .eq('project_id', projectId)
    .eq('id', publisherId)
    .maybeSingle();
  if (!data) throw ApiError.notFound('Publisher not found for this project');
  return data as Record<string, unknown>;
}

/** Create a publisher entry (provider chosen from the registered publisher catalog). */
publishersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');

    const body = z.object({ provider: z.string().min(1), name: z.string().optional() }).parse(req.body);
    const descriptor = container.registry.listPublishers().find((p) => p.id === body.provider);
    if (!descriptor) throw ApiError.badRequest(`No publisher provider '${body.provider}' is registered`);

    const { data, error } = await container.sb
      .from('seo_publishers')
      .insert({
        project_id: projectId,
        provider: body.provider,
        name: body.name ?? descriptor.name,
        config: {},
        status: 'disconnected',
        capabilities: descriptor.capabilities,
        created_by: user!.sub,
      } as never)
      .select()
      .single();
    if (error) {
      if (String(error.message).toLowerCase().includes('duplicate')) {
        throw ApiError.conflict(`A ${descriptor.name} publisher already exists for this project`);
      }
      throw ApiError.badRequest(`Could not create publisher: ${error.message}`);
    }
    res.status(201).json({ data: { publisher: data, descriptor } });
  }),
);

/** List this project's publishers, each paired with its catalog descriptor. */
publishersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const { data } = await container.sb.from('seo_publishers').select('*').eq('project_id', projectId).order('created_at');
    res.json({
      data: (data ?? []).map((p) => ({ publisher: p, descriptor: container.registry.listPublishers().find((d) => d.id === p.provider) ?? null })),
    });
  }),
);

/** One publisher plus its descriptor (never returns stored credential values). */
publishersRouter.get(
  '/:publisherId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publisherId = parseId(req, 'publisherId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const publisher = await loadPublisher(container, projectId, publisherId);
    res.json({ data: { publisher, descriptor: container.registry.listPublishers().find((d) => d.id === publisher.provider) ?? null } });
  }),
);

/** Store non-secret publisher config (field keys come from the registry descriptor). */
publishersRouter.post(
  '/:publisherId/config',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publisherId = parseId(req, 'publisherId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const publisher = await loadPublisher(container, projectId, publisherId);

    // Accept the modern { config } envelope plus the legacy { base_url } shape.
    const body = z
      .object({
        config: z.record(z.string(), z.string().or(z.number()).or(z.boolean())).optional(),
        base_url: z.string().url().or(z.string().min(1)).optional(),
      })
      .parse(req.body);
    const allowed = declaredKeys(container, String(publisher.provider), 'config');
    const incoming = { ...(body.config ?? {}), ...(body.base_url !== undefined ? { base_url: body.base_url } : {}) };
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!allowed.includes(key)) throw ApiError.badRequest(`Config key '${key}' is not allowed for publisher '${publisher.provider}'`);
      patch[key] = value;
    }
    await container.sb
      .from('seo_publishers')
      .update({ config: { ...((publisher.config as Record<string, unknown>) ?? {}), ...patch } })
      .eq('id', publisherId);
    res.json({ data: { ok: true } });
  }),
);

/** Store a publisher credential (encrypted server-side; key from the registry descriptor). */
publishersRouter.post(
  '/:publisherId/credentials',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publisherId = parseId(req, 'publisherId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const publisher = await loadPublisher(container, projectId, publisherId);
    const body = z.object({ key: z.string().min(1), value: z.string().min(1) }).parse(req.body);
    const allowed = declaredKeys(container, String(publisher.provider), 'credentials');
    if (!allowed.includes(body.key)) {
      throw ApiError.badRequest(`Credential key '${body.key}' is not allowed for publisher '${publisher.provider}'`);
    }
    if (!container.config.encryptionConfigured) {
      throw ApiError.notConfigured('Credential storage is not configured (CREDENTIALS_ENCRYPTION_KEY)');
    }
    await container.credentials.reader({ publisherId }, String(publisher.provider)).set(body.key, body.value);
    res.json({ data: { ok: true } });
  }),
);

/** Test the connection (verifies credentials against the remote system). */
publishersRouter.post(
  '/:publisherId/test',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publisherId = parseId(req, 'publisherId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const publisher = await loadPublisher(container, projectId, publisherId);
    const adapter = container.registry.getPublisher(String(publisher.provider));
    if (!adapter) throw ApiError.badRequest(`Publisher '${publisher.provider}' is not registered`);
    const ctx = buildPublisherProviderContext(container, {
      projectId,
      userId: user!.sub,
      publisherId,
      providerType: String(publisher.provider),
      config: (publisher.config as Record<string, unknown>) ?? {},
    });
    const result = await adapter.testConnection(ctx);
    await container.sb.from('seo_publishers').update({ status: result.ok ? 'connected' : 'error' }).eq('id', publisherId);
    res.json({ data: { ...result, status: result.ok ? 'connected' : 'error' } });
  }),
);

/** Begin an OAuth connect for a publisher declared setup.auth = 'oauth'. */
publishersRouter.post(
  '/:publisherId/oauth-url',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publisherId = parseId(req, 'publisherId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const result = await publisherOAuthStart(container, {
      projectId,
      publisherId,
      userId: user!.sub,
      redirectBase: redirectBase(req),
    });
    res.json({ data: result });
  }),
);

/** Disconnect: clear credentials and mark the publisher disconnected. */
publishersRouter.post(
  '/:publisherId/disconnect',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publisherId = parseId(req, 'publisherId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const publisher = await loadPublisher(container, projectId, publisherId);
    await container.credentials.clearForOwner({ publisherId });
    const current = (publisher.config as Record<string, unknown> | null) ?? {};
    const remaining: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
      if (key === 'remote_account_id' || key === 'remote_account_name' || key === 'remote_account_username') continue;
      remaining[key] = value;
    }
    await container.sb
      .from('seo_publishers')
      .update({ status: 'disconnected', config: remaining, last_error: null })
      .eq('id', publisherId);
    res.json({ data: { ok: true } });
  }),
);

/** Delete a publisher: first purge its encrypted credentials, then the row. */
publishersRouter.delete(
  '/:publisherId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publisherId = parseId(req, 'publisherId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    await loadPublisher(container, projectId, publisherId);
    await container.credentials.clearForOwner({ publisherId });
    await container.sb.from('seo_publishers').delete().eq('project_id', projectId).eq('id', publisherId);
    res.json({ data: { ok: true } });
  }),
);
