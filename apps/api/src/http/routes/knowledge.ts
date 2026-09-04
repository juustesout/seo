/** Knowledge base API: project-scoped semantic search against the Qdrant provider. */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseProjectId } from './utils.js';

export const knowledgeRouter: Router = Router({ mergeParams: true });

knowledgeRouter.use(requireAuth);

/** Semantic search over the project knowledge base (never leaks other projects). */
knowledgeRouter.post(
  '/search',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');

    const body = z.object({ query: z.string().min(1).max(500), kind: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }).parse(req.body);
    const provider = container.registry.getKnowledge('qdrant');
    if (!provider) throw ApiError.notConfigured('No knowledge provider is configured on this server');
    if (!container.config.env.QDRANT_URL || !process.env.EMBEDDINGS_API_KEY) {
      throw ApiError.notConfigured('Knowledge search is not configured (QDRANT_URL / EMBEDDINGS_API_KEY)');
    }

    const hits = await provider.search({
      query: body.query,
      projectId,
      filter: body.kind ? { kind: body.kind } : undefined,
      limit: body.limit ?? 8,
    });
    res.json({ data: { results: hits } });
  }),
);

knowledgeRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const descriptor = container.registry.listKnowledge()[0] ?? null;
    res.json({
      data: {
        project_id: projectId,
        provider: descriptor,
        configured: Boolean(container.config.env.QDRANT_URL && container.config.env.QDRANT_API_KEY && process.env.EMBEDDINGS_API_KEY),
        // queue the indexing work rather than doing it inline: honest state is
        // reported by seo_sync_jobs rows.
        note: descriptor ? 'Run a knowledge_index job to (re)build the vector index.' : 'No knowledge provider registered.',
      },
    });
  }),
);
