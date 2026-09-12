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
import {
  KNOWLEDGE_SOURCE_STATUSES,
  KNOWLEDGE_SOURCE_SORTS,
  KNOWLEDGE_SOURCE_TYPES,
} from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseId, parseProjectId } from './utils.js';
import { KnowledgeService, KNOWLEDGE_MAX_CHARS, normalizeSourceTypeInput } from '../../services/knowledgeService.js';
import {
  KNOWLEDGE_LIST_DEFAULT_LIMIT,
  KNOWLEDGE_LIST_MAX_LIMIT,
  KNOWLEDGE_SEARCH_MAX_CHARS,
} from '../../knowledge/limits.js';

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

/**
 * Bounded, allowlisted source-list query (KB5). Every value is validated at the
 * edge: unknown types/statuses/sorts are rejected, the search term is capped,
 * and limit is hard-capped so the list can never be unbounded. The service maps
 * the sort value onto a fixed column/direction pair.
 */
const listSourcesSchema = z.object({
  type: z.enum(KNOWLEDGE_SOURCE_TYPES).optional(),
  status: z.enum(KNOWLEDGE_SOURCE_STATUSES).optional(),
  search: z.string().trim().max(KNOWLEDGE_SEARCH_MAX_CHARS).optional(),
  sort: z.enum(KNOWLEDGE_SOURCE_SORTS).default('updated_desc'),
  limit: z.coerce.number().int().min(1).max(KNOWLEDGE_LIST_MAX_LIMIT).default(KNOWLEDGE_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * List this project's sources (filtered/sorted/paginated) plus project-level
 * health counts and whether the server can index/search them.
 */
knowledgeRouter.get(
  '/sources',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const query = listSourcesSchema.parse(req.query);
    const svc = new KnowledgeService(container);
    const descriptor = container.registry.listKnowledge()[0] ?? null;
    const reason = svc.configuredReason();
    const page = await svc.listSources(projectId, query);
    res.json({
      data: {
        project_id: projectId,
        configured: reason === null,
        provider: descriptor,
        note: descriptor ? reason ?? 'Sources are indexed into this project’s isolated vector space.' : 'No knowledge provider registered.',
        ...page,
      },
    });
  }),
);

/**
 * One source's safe detail (KB5), including a bounded plain-text preview for
 * text/URL sources whose body is stored. Strictly project-scoped: a source from
 * another project is a 404, never an existence oracle.
 */
knowledgeRouter.get(
  '/sources/:sourceId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const sourceId = parseId(req, 'sourceId');
    const svc = new KnowledgeService(container);
    const detail = await svc.getSourceDetail(projectId, sourceId);
    res.json({ data: detail });
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
 * Upload a knowledge file (KB4). The file is sent as the raw request body with
 * its original name in `?filename=`; the type comes from the Content-Type
 * header and is re-validated from the bytes server-side. The file is stored
 * privately and the source is created in `draft` - ingestion is a separate,
 * explicit step so a large PDF never blocks this request.
 */
knowledgeRouter.post(
  '/sources/upload',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.length === 0) {
      throw ApiError.badRequest(
        'Send the file as the raw request body (Content-Type: text/plain, text/markdown, application/pdf or the DOCX type) with ?filename=',
      );
    }
    const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
    if (!filename.trim()) throw ApiError.badRequest('Provide the original filename as ?filename=');
    const contentTypeHeader = req.headers['content-type'];
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader.split(';')[0]! : '';
    const svc = new KnowledgeService(container);
    const { source } = await svc.createFileSource(projectId, user!.sub, { filename, contentType, bytes });
    res.status(201).json({ data: { source } });
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
