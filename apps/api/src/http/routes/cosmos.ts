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
import { COSMOS_FIELD_MAX_CHARS, COSMOS_FONT_FAMILY_MAX_CHARS } from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseProjectId } from './utils.js';
import { readCosmosConfig, writeCosmosConfig } from '../../services/cosmosService.js';

export const cosmosRouter: Router = Router({ mergeParams: true });

cosmosRouter.use(requireAuth);

const field = z.string().max(COSMOS_FIELD_MAX_CHARS);

/**
 * Bounded design-token input (Stage 5). Only semantic values are accepted: a
 * hex palette, a safe font-family charset, fixed weights, and preset enums. The
 * route never accepts raw CSS.
 */
const cosmosColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
const cosmosFontFamily = z
  .string()
  .max(COSMOS_FONT_FAMILY_MAX_CHARS)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ,"'-]*$/);
const cosmosFontWeight = z.union([z.literal(300), z.literal(400), z.literal(500), z.literal(600), z.literal(700), z.literal(800)]);

const designSchema = z
  .object({
    colors: z
      .object({
        primary: cosmosColor.optional(),
        secondary: cosmosColor.optional(),
        accent: cosmosColor.optional(),
        background: cosmosColor.optional(),
        surface: cosmosColor.optional(),
        text: cosmosColor.optional(),
        muted: cosmosColor.optional(),
        border: cosmosColor.optional(),
        success: cosmosColor.optional(),
        warning: cosmosColor.optional(),
        danger: cosmosColor.optional(),
      })
      .strict()
      .optional(),
    typography: z
      .object({
        headingFamily: cosmosFontFamily.optional(),
        bodyFamily: cosmosFontFamily.optional(),
        headingWeight: cosmosFontWeight.optional(),
        bodyWeight: cosmosFontWeight.optional(),
        headingScale: z.enum(['compact', 'default', 'large']).optional(),
        bodySize: z.enum(['sm', 'md', 'lg']).optional(),
        lineHeight: z.number().min(1).max(2.2).optional(),
      })
      .strict()
      .optional(),
    spacingScale: z.enum(['compact', 'comfortable', 'spacious']).optional(),
    radiusScale: z.enum(['none', 'small', 'medium', 'large']).optional(),
    elevation: z.enum(['none', 'subtle', 'medium', 'strong']).optional(),
  })
  .strict()
  .optional();

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
    design: designSchema,
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
