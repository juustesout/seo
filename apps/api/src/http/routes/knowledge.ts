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
  KNOWLEDGE_COLLECTION_DESCRIPTION_MAX_CHARS,
  KNOWLEDGE_COLLECTION_NAME_MAX_CHARS,
  KNOWLEDGE_DISCOVERY_APPLY_MAX_URLS,
  KNOWLEDGE_DISCOVERY_MAX_DEPTH,
  KNOWLEDGE_DISCOVERY_MAX_URLS,
  KNOWLEDGE_DISCOVERY_SCOPES,
  KNOWLEDGE_DISCOVERY_SEED_MAX_CHARS,
  KNOWLEDGE_FRESHNESS_STATES,
  KNOWLEDGE_REFRESH_POLICIES,
  KNOWLEDGE_SOURCE_BULK_MAX_IDS,
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
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  KNOWLEDGE_SEARCH_MAX_SOURCE_FILTERS,
  KNOWLEDGE_SEARCH_QUERY_MAX_CHARS,
} from '../../knowledge/limits.js';

export const knowledgeRouter: Router = Router({ mergeParams: true });

knowledgeRouter.use(requireAuth);

/** True when the server could embed (either the dedicated key or the shared OpenAI key is set). */
const hasEmbeddingKey = () => Boolean(process.env.EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY);

/**
 * Bounded, allowlisted retrieval request (KB6). The query is required and
 * bounded; filters are limited to the canonical source types and to bounded
 * UUID source ids; the result limit is hard-capped. All validation happens at
 * the edge so the service only ever sees a safe, typed request.
 */
const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(KNOWLEDGE_SEARCH_QUERY_MAX_CHARS),
    limit: z.number().int().min(1).max(KNOWLEDGE_SEARCH_MAX_LIMIT).optional(),
    source_types: z.array(z.enum(KNOWLEDGE_SOURCE_TYPES)).min(1).max(KNOWLEDGE_SOURCE_TYPES.length).optional(),
    source_ids: z.array(z.string().uuid()).min(1).max(KNOWLEDGE_SEARCH_MAX_SOURCE_FILTERS).optional(),
    collection_id: z.string().uuid().optional(),
    uncategorized: z.boolean().optional(),
  })
  .refine((value) => !(value.collection_id && value.uncategorized), {
    message: 'collection_id and uncategorized are mutually exclusive',
    path: ['uncategorized'],
  });

/**
 * Canonical, attributed semantic search over the project knowledge base. The
 * service owns normalization, bounding, attribution (fail closed) and
 * diagnostics; the route only authorizes (viewers may search) and validates.
 */
knowledgeRouter.post(
  '/search',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');

    const body = searchSchema.parse(req.body);
    const svc = new KnowledgeService(container);
    const result = await svc.search(projectId, {
      query: body.query,
      limit: body.limit,
      sourceTypes: body.source_types,
      sourceIds: body.source_ids,
      collectionId: body.collection_id,
      uncategorized: body.uncategorized,
    });
    res.json({ data: result });
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
  freshness: z.enum(KNOWLEDGE_FRESHNESS_STATES).optional(),
  collection_id: z.string().uuid().optional(),
  uncategorized: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
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

/**
 * Bounded source update (KB7 policy, KB8 collection). Exactly one purpose per
 * call is enough, but both may be supplied; each is validated by the service.
 * `collection_id: null` removes the source from its collection (uncategorized).
 */
const updateSourceSchema = z
  .object({
    refresh_policy: z.enum(KNOWLEDGE_REFRESH_POLICIES).optional(),
    collection_id: z.string().uuid().nullable().optional(),
  })
  .refine((value) => value.refresh_policy !== undefined || value.collection_id !== undefined, {
    message: 'Provide refresh_policy and/or collection_id',
  });

knowledgeRouter.patch(
  '/sources/:sourceId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const sourceId = parseId(req, 'sourceId');
    const body = updateSourceSchema.parse(req.body);
    const svc = new KnowledgeService(container);
    let source = body.refresh_policy
      ? await svc.updateRefreshPolicy(projectId, sourceId, body.refresh_policy)
      : await svc.getSourceDetail(projectId, sourceId);
    if (body.collection_id !== undefined) {
      source = await svc.assignCollection(projectId, sourceId, body.collection_id);
    }
    res.json({ data: { source } });
  }),
);

/**
 * Bulk move sources into a collection, or out of every collection with a null
 * `collection_id` (KB8). Atomic and fail-closed in the service: if any id is
 * unknown/foreign nothing changes. Editors and above only.
 */
const bulkAssignSchema = z.object({
  source_ids: z.array(z.string().uuid()).min(1).max(KNOWLEDGE_SOURCE_BULK_MAX_IDS),
  collection_id: z.string().uuid().nullable(),
});

knowledgeRouter.post(
  '/sources/bulk',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = bulkAssignSchema.parse(req.body);
    const svc = new KnowledgeService(container);
    const result = await svc.bulkAssignCollection(projectId, body.source_ids, body.collection_id);
    res.json({ data: { updated: result.updated, collection_id: result.collectionId } });
  }),
);

/**
 * Explicit manual refresh of a URL source (KB7). Re-validates the URL, refuses
 * a refresh already in flight (conflict) and queues `knowledge_source_refresh`.
 * The worker re-fetches, hashes and only reindexes when the content changed.
 */
knowledgeRouter.post(
  '/sources/:sourceId/refresh',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const sourceId = parseId(req, 'sourceId');
    const svc = new KnowledgeService(container);
    const job = await svc.enqueueRefresh(projectId, sourceId, user!.sub);
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

// ---------------------------------------------------------------------------
// Knowledge collections (KB8) - optional, project-scoped source organization.
// Viewers read; editors manage. Collections are organizational metadata only:
// deleting one never deletes its sources (they become uncategorized).
// ---------------------------------------------------------------------------

/** Bounded collection list/detail pagination (same caps as the source list). */
const listCollectionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(KNOWLEDGE_LIST_MAX_LIMIT).default(KNOWLEDGE_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

const createCollectionSchema = z.object({
  name: z.string().trim().min(1).max(KNOWLEDGE_COLLECTION_NAME_MAX_CHARS),
  description: z.string().trim().max(KNOWLEDGE_COLLECTION_DESCRIPTION_MAX_CHARS).nullable().optional(),
});

const updateCollectionSchema = z
  .object({
    name: z.string().trim().min(1).max(KNOWLEDGE_COLLECTION_NAME_MAX_CHARS).optional(),
    description: z.string().trim().max(KNOWLEDGE_COLLECTION_DESCRIPTION_MAX_CHARS).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: 'Provide name and/or description',
  });

/** List this project's collections with per-collection source counts. */
knowledgeRouter.get(
  '/collections',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const query = listCollectionsSchema.parse(req.query);
    const svc = new KnowledgeService(container);
    const page = await svc.listCollections(projectId, query);
    res.json({ data: page });
  }),
);

/** One collection with a bounded page of its sources. */
knowledgeRouter.get(
  '/collections/:collectionId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const collectionId = parseId(req, 'collectionId');
    const query = listCollectionsSchema.parse(req.query);
    const svc = new KnowledgeService(container);
    const detail = await svc.getCollectionDetail(projectId, collectionId, query);
    res.json({ data: detail });
  }),
);

/** Create a collection (editor+). */
knowledgeRouter.post(
  '/collections',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = createCollectionSchema.parse(req.body);
    const svc = new KnowledgeService(container);
    const collection = await svc.createCollection(projectId, user!.sub, {
      name: body.name,
      description: body.description ?? null,
    });
    res.status(201).json({ data: { collection } });
  }),
);

/** Rename / re-describe a collection (editor+). */
knowledgeRouter.patch(
  '/collections/:collectionId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const collectionId = parseId(req, 'collectionId');
    const body = updateCollectionSchema.parse(req.body);
    const svc = new KnowledgeService(container);
    const collection = await svc.updateCollection(projectId, collectionId, body);
    res.json({ data: { collection } });
  }),
);

/**
 * Delete a collection (editor+). Its sources are never deleted - they are
 * returned to uncategorized. The response names that outcome explicitly.
 */
knowledgeRouter.delete(
  '/collections/:collectionId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const collectionId = parseId(req, 'collectionId');
    const svc = new KnowledgeService(container);
    await svc.deleteCollection(projectId, collectionId);
    res.json({ data: { id: collectionId, deleted: true, sources_deleted: false } });
  }),
);

// ---------------------------------------------------------------------------
// Knowledge discovery (KB9) - bounded, human-approved link discovery.
//
// Discovery only proposes candidate URLs; nothing is fetched or indexed inside
// these routes. A session runs in the worker, a viewer polls it, and an editor
// applies a reviewed selection (which creates normal URL sources and queues the
// existing ingestion).
// ---------------------------------------------------------------------------

/** Bounded discovery request. Every value is validated/clamped at the edge. */
const startDiscoverySchema = z.object({
  seedUrl: z.string().trim().min(1).max(KNOWLEDGE_DISCOVERY_SEED_MAX_CHARS),
  collectionId: z.string().uuid().nullable().optional(),
  maxUrls: z.number().int().min(1).max(KNOWLEDGE_DISCOVERY_MAX_URLS).optional(),
  maxDepth: z.number().int().min(0).max(KNOWLEDGE_DISCOVERY_MAX_DEPTH).optional(),
  scope: z.enum(KNOWLEDGE_DISCOVERY_SCOPES).optional(),
});

/** Start a discovery session (editor+). Returns the queued session + job. */
knowledgeRouter.post(
  '/discovery',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = startDiscoverySchema.parse(req.body);
    const svc = new KnowledgeService(container);
    const result = await svc.startDiscovery(projectId, user!.sub, {
      seedUrl: body.seedUrl,
      collectionId: body.collectionId ?? null,
      maxUrls: body.maxUrls,
      maxDepth: body.maxDepth,
      scope: body.scope,
    });
    res.status(202).json({ data: result });
  }),
);

/** One discovery session with its bounded candidate proposal (viewer+). */
knowledgeRouter.get(
  '/discovery/:sessionId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const sessionId = parseId(req, 'sessionId');
    const svc = new KnowledgeService(container);
    const session = await svc.getDiscoverySession(projectId, sessionId);
    res.json({ data: session });
  }),
);

/** Apply a reviewed selection from a `ready`/`applied` session (editor+). */
const applyDiscoverySchema = z.object({
  urls: z
    .array(z.string().trim().min(1).max(KNOWLEDGE_DISCOVERY_SEED_MAX_CHARS))
    .min(1)
    .max(KNOWLEDGE_DISCOVERY_APPLY_MAX_URLS),
});

knowledgeRouter.post(
  '/discovery/:sessionId/apply',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const sessionId = parseId(req, 'sessionId');
    const body = applyDiscoverySchema.parse(req.body);
    const svc = new KnowledgeService(container);
    const result = await svc.applyDiscovery(projectId, user!.sub, sessionId, body.urls);
    res.json({ data: result });
  }),
);
