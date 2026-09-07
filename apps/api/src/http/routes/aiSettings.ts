/**
 * Project AI settings API (BYOK). All secrets stay server-side; the browser
 * reads only non-secret status (provider, models, configured flag, key source)
 * and submits new keys that are stored encrypted per project.
 *
 * Mounted under /api/projects/:projectId/ai (mergeParams). Session-authenticated
 * with role gates per operation - viewer may read settings, editor may change
 * model/provider preferences, admin alone may set or delete the project's API
 * key. Setting a key is admin-only because a BYOK key is shared infrastructure
 * for the whole project (jobs + editors consume it); letting an editor rotate
 * it would break running AI features without warning.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseProjectId } from './utils.js';
import { AIService } from '../../services/aiService.js';

export const aiSettingsRouter: Router = Router({ mergeParams: true });

aiSettingsRouter.use(requireAuth);

const settingsSchema = z.object({
  provider: z.string().min(1).optional(),
  chatModel: z.string().min(1).optional(),
  embeddingModel: z.string().min(1).optional(),
});

const keySchema = z.object({
  apiKey: z.string().min(8).max(500).nullable(),
});

/** Read non-secret AI status (provider, models, configured, key source). */
aiSettingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const ai = new AIService(container);
    res.json({ data: await ai.status(projectId) });
  }),
);

/** Update provider/model preferences (editor+). No key is accepted here. */
aiSettingsRouter.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = settingsSchema.parse(req.body);
    const ai = new AIService(container);
    res.json({ data: await ai.updateSettings(projectId, body) });
  }),
);

/** Set (or remove) the project's BYOK key (admin only). apiKey null deletes it. */
aiSettingsRouter.put(
  '/key',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const body = keySchema.parse(req.body);
    const ai = new AIService(container);
    res.json({ data: await ai.setApiKey(projectId, body.apiKey ?? null) });
  }),
);

/** Remove the project's BYOK key entirely (admin only). */
aiSettingsRouter.delete(
  '/key',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const ai = new AIService(container);
    res.json({ data: await ai.setApiKey(projectId, null) });
  }),
);
