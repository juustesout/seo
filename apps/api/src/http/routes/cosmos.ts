/**
 * Cosmos configuration API (project-scoped editorial/brand context).
 *
 * viewer may read the config; editor+ may update it. The config is
 * non-secret and lives in `seo_projects.settings.cosmos`, so no dedicated table
 * or migration is needed. The same service that renders the bounded AI context
 * owns persistence, so reads and writes can never drift from the prompt shape.
 */

import { Router } from 'express';
import { z } from 'zod';
import { COSMOS_FIELD_MAX_CHARS } from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseProjectId } from './utils.js';
import { readCosmosConfig, writeCosmosConfig } from '../../services/cosmosService.js';

export const cosmosRouter: Router = Router({ mergeParams: true });

cosmosRouter.use(requireAuth);

const field = z.string().max(COSMOS_FIELD_MAX_CHARS);

const cosmosSchema = z
  .object({
    identity: z
      .object({ name: field.optional(), description: field.optional(), audience: field.optional() })
      .strict()
      .optional(),
    voice: z
      .object({
        tone: field.optional(),
        formality: field.optional(),
        personality: field.optional(),
        vocabulary: field.optional(),
      })
      .strict()
      .optional(),
    editorial: z
      .object({
        writingRules: field.optional(),
        preferredStructure: field.optional(),
        articleCharacteristics: field.optional(),
        forbidden: field.optional(),
      })
      .strict()
      .optional(),
    seo: z
      .object({ rules: field.optional(), searchIntent: field.optional(), internalLinking: field.optional() })
      .strict()
      .optional(),
    knowledge: z.object({ notes: field.optional(), useProjectKnowledge: z.boolean().optional() }).strict().optional(),
  })
  .strict();

/** Read the project's Cosmos config (viewer+). */
cosmosRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    res.json({ data: await readCosmosConfig(container, projectId) });
  }),
);

/** Replace the project's Cosmos config (editor+). */
cosmosRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = cosmosSchema.parse(req.body ?? {});
    res.json({ data: await writeCosmosConfig(container, projectId, body) });
  }),
);
