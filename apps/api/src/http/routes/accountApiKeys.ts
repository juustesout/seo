/**
 * Account (master) API key management (session-authenticated UI routes).
 * Mounted at /api/account/api-keys.
 *
 * A master key is the multi-project twin of a project key: project_id is NULL
 * and the key may reach every project the owning user is a member of, never
 * stronger than that membership (the per-request role is resolved at the REST
 * v1 / MCP boundary). Management is strictly owner-scoped: a user can only
 * see, create and revoke their own account keys. The plaintext key is shown
 * exactly once at creation.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseId } from './utils.js';
import { ApiKeyStore, type ApiKeyScope } from '../../infra/apiKeys.js';

export const accountApiKeysRouter: Router = Router();

accountApiKeysRouter.use(requireAuth);

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    scopes: z.array(z.enum(['read', 'write'])).optional(),
  })
  .passthrough();

accountApiKeysRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    await container.access.requireAccount(user!.sub);
    const store = new ApiKeyStore(container.sb);
    const keys = await store.listAccountKeys(user!.sub);
    res.json({
      data: {
        keys,
        note: 'Account API keys reach every project you are a member of, limited to your role in that project.',
      },
    });
  }),
);

accountApiKeysRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    await container.access.requireAccount(user!.sub);
    const body = createSchema.parse(req.body);
    const scopesRaw = body.scopes?.length ? body.scopes : (['read'] as ApiKeyScope[]);
    const store = new ApiKeyStore(container.sb);
    const { key, record } = await store.create(null, user!.sub, body.name, scopesRaw);
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

accountApiKeysRouter.post(
  '/:keyId/revoke',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    await container.access.requireAccount(user!.sub);
    const store = new ApiKeyStore(container.sb);
    await store.revokeAccountKey(user!.sub, parseId(req, 'keyId'));
    res.json({ data: { ok: true } });
  }),
);

accountApiKeysRouter.delete(
  '/:keyId',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    await container.access.requireAccount(user!.sub);
    const store = new ApiKeyStore(container.sb);
    await store.revokeAccountKey(user!.sub, parseId(req, 'keyId'));
    res.status(204).send();
  }),
);
