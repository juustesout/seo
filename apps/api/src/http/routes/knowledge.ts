/**
 * Knowledge base API (project-scoped, Content Studio).
 *
 * Semantic search + status against the existing Qdrant provider, plus the
 * user-managed knowledge *sources* model introduced in Phase E. Routes are
 * thin: authorization happens here, then KnowledgeService does the work and
 * background ingest/delete runs in the worker (never blocking HTTP).
 *
 * Mounted at /api/projects/:projectId/knowledge. Session-authenticated with
 * role gates: viewers search and read source lists/status, editors add,
 * reindex and delete sources. "Not configured" states are reported honestly -
 * if Qdrant or an embedding key is absent the API says so instead of returning
 * empty/fake results.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseId, parseProjectId } from './utils.js';
import { KnowledgeService, KNOWLEDGE_MAX_CHARS, normalizeSourceTypeInput } from '../../services/knowledgeService.js';

export const knowledgeRouter: Router = Router({ mergeParams: true });

knowledgeRouter.use(requireAuth);

/** True when the server could embed (either the dedicated key or the shared OpenAI key is set). */
const hasEmbeddingKey = () => Boolean(process.env.EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY);

/**
 * Semantic search over the project knowledge base (never leaks other projects).
 */
knowledgeRouter.post(
  '/search',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');

    const body = z.object({ query: z.string().min(1).max(500), kind: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }).parse(req.body);
    const provider = container.registry.getKnowledge('qdrant');
    if (!provider) throw ApiError.notConfigured('No knowledge provider is configured on this server');
    if (!container.config.env.QDRANT_URL || !hasEmbeddingKey()) {
      throw ApiError.notConfigured(
        'Knowledge search is not configured (set QDRANT_URL and an embedding key: EMBEDDINGS_API_KEY or OPENAI_API_KEY)',
      );
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

/** Server-side capability status: which provider is registered and whether indexing/search can run. */
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
        configured: Boolean(container.config.env.QDRANT_URL && container.config.env.QDRANT_API_KEY && hasEmbeddingKey()),
        note: descriptor ? 'Run a knowledge_index job to (re)build the vector index.' : 'No knowledge provider registered.',
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Knowledge sources (user-managed, project-scoped items)
// ---------------------------------------------------------------------------

/**
 * Boundary schema. Input accepts the canonical vocabulary plus the legacy
 * `note`/`reference` values for backwards compatibility; they are normalized to
 * canonical `text` before the service ever sees them. `file` is accepted here
 * so the service can report a precise "not available" capability error.
 */
const createSourceSchema = z
  .object({
    name: z.string().min(1).max(200),
    source_type: z.enum(['text', 'url', 'file', 'note', 'reference']).optional(),
    url: z.string().max(2000).nullable().optional(),
    text: z.string().max(KNOWLEDGE_MAX_CHARS).nullable().optional(),
  })
  .passthrough()
  .transform((value) => ({
    ...value,
    source_type: value.source_type ? normalizeSourceTypeInput(value.source_type) : undefined,
  }));

/** List this project's sources + whether the server can index/search them. */
knowledgeRouter.get(
  '/sources',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const svc = new KnowledgeService(container);
    const descriptor = container.registry.listKnowledge()[0] ?? null;
    const reason = svc.configuredReason();
    const [sources] = await Promise.all([svc.listSources(projectId)]);
    res.json({
      data: {
        project_id: projectId,
        configured: reason === null,
        provider: descriptor,
        note: descriptor ? reason ?? 'Sources are indexed into this project’s isolated vector space.' : 'No knowledge provider registered.',
        sources,
      },
    });
  }),
);

/** Add a source (row + queued background ingest). */
knowledgeRouter.post(
  '/sources',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = createSourceSchema.parse(req.body);
    const svc = new KnowledgeService(container);
    const { source, job } = await svc.createSource(projectId, user!.sub, {
      sourceType: body.source_type,
      name: body.name,
      url: body.url ?? null,
      text: body.text ?? null,
    });
    res.status(202).json({ data: { source, job } });
  }),
);

/**
 * Fetch + index a source now. For a URL source this triggers the first fetch
 * (draft -> queued); for a failed source it retries; for a ready source it
 * runs the reindex flow. A source already queued/processing is rejected so no
 * second job is created. Deleted sources are refused by the lifecycle guard.
 */
knowledgeRouter.post(
  '/sources/:sourceId/ingest',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const sourceId = parseId(req, 'sourceId');
    const svc = new KnowledgeService(container);
    const job = await svc.enqueueIngest(projectId, sourceId, user!.sub);
    res.status(202).json({ data: { job } });
  }),
);

/** Re-queue ingestion for a source (e.g. retry after an error). */
knowledgeRouter.post(
  '/sources/:sourceId/reindex',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const sourceId = parseId(req, 'sourceId');
    const svc = new KnowledgeService(container);
    const job = await svc.enqueueIngest(projectId, sourceId, user!.sub);
    res.status(202).json({ data: { job } });
  }),
);

/** Remove a source: queues vector deletion then removes the row. */
knowledgeRouter.delete(
  '/sources/:sourceId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const sourceId = parseId(req, 'sourceId');
    const svc = new KnowledgeService(container);
    const job = await svc.enqueueDelete(projectId, sourceId, user!.sub);
    res.status(202).json({ data: { job } });
  }),
);
