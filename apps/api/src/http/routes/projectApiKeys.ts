/**
 * Project API key management (session-authenticated UI routes).
 * Owners/admins create, list and revoke keys; the plaintext key is shown once.
 *
 * Mounted at /api/projects/:projectId/api-keys. These keys are the bearer
 * credentials for the REST v1 and MCP surfaces, so management is deliberately
 * admin-only (container.access.requireRole ... 'admin'): whoever can mint a key
 * can act as the project over those interfaces. The ApiKeyStore scopes every
 * operation to the project, and the plaintext token is returned exactly once -
 * it is stored only as a hash, so revoke is the only way to invalidate it.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseId, parseProjectId } from './utils.js';
import { ApiKeyStore, type ApiKeyScope } from '../../infra/apiKeys.js';

export const projectApiKeysRouter: Router = Router({ mergeParams: true });

projectApiKeysRouter.use(requireAuth);

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    scopes: z.array(z.enum(['read', 'write'])).optional(),
  })
  .passthrough();

/** List this project's API keys (non-secret records; admins only). */
projectApiKeysRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const store = new ApiKeyStore(container.sb);
    res.json({ data: { keys: await store.list(projectId) } });
  }),
);

/** Create a project API key (scopes default to read). The plaintext is shown once. */
projectApiKeysRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const body = createSchema.parse(req.body);
    const scopesRaw = body.scopes?.length ? body.scopes : (['read'] as ApiKeyScope[]);
    const store = new ApiKeyStore(container.sb);
    const { key, record } = await store.create(projectId, user!.sub, body.name, scopesRaw);
    res.status(201).json({
      data: {
        key,
        id: record.id,
        name: record.name,
        scopes: record.scopes,
        // The plaintext key can never be shown again.
        note: 'Store this key securely; it will not be shown again.',
      },
    });
  }),
);

/** Revoke one key (POST variant used by the UI action button). */
projectApiKeysRouter.post(
  '/:keyId/revoke',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const store = new ApiKeyStore(container.sb);
    await store.revoke(projectId, parseId(req, 'keyId'));
    res.json({ data: { ok: true } });
  }),
);

/** Revoke one key (DELETE variant). */
projectApiKeysRouter.delete(
  '/:keyId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const store = new ApiKeyStore(container.sb);
    await store.revoke(projectId, parseId(req, 'keyId'));
    res.status(204).send();
  }),
);
