/**
 * Account AI API (BYOK): configure the account-level AI providers (OpenAI)
 * that every project under the account can use. Keys are stored encrypted
 * under the account's seo_integrations vault row - the browser only ever sees
 * non-secret status (configured / not configured), never the key itself.
 *
 * Mounted at /api/account/ai. Session-authenticated; the account is derived
 * from the caller. Routes are thin: they parse the key body and delegate to
 * AIService (services/aiService.ts), which owns where the encrypted key row
 * lives and how status is derived. The API key arrives over TLS once and is
 * never echoed back or logged.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { AIService } from '../../services/aiService.js';

export const accountAiRouter: Router = Router();

accountAiRouter.use(requireAuth);

const keySchema = z.object({
  provider: z.string().optional(),
  apiKey: z.string().min(8).max(500).nullable(),
});

const removeSchema = z.object({ provider: z.string().optional() });

/** Non-secret status for every registered AI provider on this account. */
accountAiRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    const accountId = (await container.access.requireAccount(user!.sub)).account_id;
    const ai = new AIService(container);
    res.json({ data: await ai.accountStatus(accountId) });
  }),
);

/**
 * Set (or with apiKey null, remove) the encrypted account key for a provider.
 * Only the presence of a key is ever reported back - never the value.
 */
accountAiRouter.put(
  '/key',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    const body = keySchema.parse(req.body);
    const accountId = (await container.access.requireAccount(user!.sub)).account_id;
    const ai = new AIService(container);
    await ai.setAccountKey(accountId, user!.sub, body.provider ?? 'openai', body.apiKey ?? null);
    res.json({ data: await ai.accountStatus(accountId) });
  }),
);

/** Remove the account key for a provider (resets that provider to "not configured"). */
accountAiRouter.delete(
  '/key',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    const query = removeSchema.parse(req.query);
    const accountId = (await container.access.requireAccount(user!.sub)).account_id;
    const ai = new AIService(container);
    await ai.setAccountKey(accountId, user!.sub, query.provider ?? 'openai', null);
    res.json({ data: await ai.accountStatus(accountId) });
  }),
);
