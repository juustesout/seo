/** Publishers API: connect output channels (e.g. WordPress) and test them. */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { buildPublisherProviderContext } from '../../context.js';
import { parseId, parseProjectId } from './utils.js';

export const publishersRouter: Router = Router({ mergeParams: true });

publishersRouter.use(requireAuth);

const WP_CRED_KEYS = ['wordpress_username', 'wordpress_application_password'] as const;

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

/** Store a non-secret site URL for the publisher (WP REST base). */
publishersRouter.post(
  '/:publisherId/config',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publisherId = parseId(req, 'publisherId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const publisher = await loadPublisher(container, projectId, publisherId);
    const body = z.object({ base_url: z.string().url().or(z.string().min(1)) }).parse(req.body);
    await container.sb
      .from('seo_publishers')
      .update({ config: { ...((publisher.config as Record<string, unknown>) ?? {}), base_url: body.base_url } })
      .eq('id', publisherId);
    res.json({ data: { ok: true } });
  }),
);

/** Store a publisher credential (encrypted server-side). */
publishersRouter.post(
  '/:publisherId/credentials',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publisherId = parseId(req, 'publisherId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const publisher = await loadPublisher(container, projectId, publisherId);
    const body = z.object({ key: z.string().min(1), value: z.string().min(1) }).parse(req.body);
    if (!(WP_CRED_KEYS as readonly string[]).includes(body.key)) {
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

/** Disconnect: clear credentials and mark the publisher disconnected. */
publishersRouter.post(
  '/:publisherId/disconnect',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const publisherId = parseId(req, 'publisherId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    await loadPublisher(container, projectId, publisherId);
    await container.credentials.clearForOwner({ publisherId });
    await container.sb.from('seo_publishers').update({ status: 'disconnected' }).eq('id', publisherId);
    res.json({ data: { ok: true } });
  }),
);

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
