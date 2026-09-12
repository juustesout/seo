/**
 * Knowledge source service (SEO Core).
 *
 * Project-scoped user-managed knowledge items for Content Studio. Each source
 * row is the logical model of an indexed item; its vectors live in the shared
 * Qdrant collection under external_id `source:<id>` so every vector is
 * traceable back to this table. This service is the single owner of the
 * ingestion pipeline for these sources - it is called by the HTTP routes
 * (add/remove/list/retry) AND by the worker executors (background ingest and
 * deletion). It reuses the registered QdrantKnowledgeProvider and its
 * embedding/chunking unchanged - there is deliberately no second vector/RAG
 * implementation here.
 *
 * One canonical pipeline (KB2, extended in KB3):
 *
 *   source row -> extract (knowledgeText) -> normalize        [here]
 *              -> chunk (provider chunker) -> embed -> index  [provider]
 *
 * `text` is fully supported. `url` sources are fetched through the injected
 * `KnowledgeFetcher` (Jina today) and the captured body then flows through the
 * exact same normalize -> chunk -> index path - there is no URL-specific
 * pipeline. The fetched body is persisted to `content_text` on success so the
 * row is self-contained and the index stays rebuildable without re-fetching.
 * `file` honestly reports "not available" until KB4. Postgres stays the source
 * of truth: normalization is processing output only and Qdrant is always
 * rebuildable from the row.
 *
 * Lifecycle is centralized in knowledgeLifecycle.ts. Status changes here are
 * compare-and-swap (`patchRow`) so a delete or concurrent worker can never be
 * overridden by a late writer; an ingest that loses the race compensates by
 * removing the vectors it just wrote.
 *
 * Project isolation is enforced at every layer: the row is read/written under
 * a project_id filter, and the Qdrant provider filters every search/delete on
 * project_id too.
 */

import type {
  FetchedDocument,
  KnowledgeCollectionDetailDto,
  KnowledgeCollectionDto,
  KnowledgeCollectionsResponse,
  KnowledgeDiscoveryApplyItem,
  KnowledgeDiscoveryApplyResultDto,
  KnowledgeDiscoveryCandidate,
  KnowledgeDiscoveryRequest,
  KnowledgeDiscoverySessionDetailDto,
  KnowledgeDiscoverySessionDto,
  KnowledgeDiscoveryStatus,
  KnowledgeDiscoveryScope,
  KnowledgeDiscoveryReason,
  KnowledgeDocumentInput,
  KnowledgeDueRefreshDto,
  KnowledgeFetcher,
  KnowledgeFile,
  KnowledgeProvider,
  KnowledgeRefreshPolicy,
  KnowledgeSearchFilter,
  KnowledgeSearchHitDto,
  KnowledgeSearchResponse,
  KnowledgeSearchResult,
  KnowledgeSourceDetailDto,
  KnowledgeSourceDto,
  KnowledgeSourceListQuery,
  KnowledgeSourcePreviewDto,
  KnowledgeSourceStatus,
  KnowledgeSourceSummaryDto,
  KnowledgeSourceType,
  ProviderContext,
} from '@seo/contracts';
import {
  KNOWLEDGE_COLLECTION_DESCRIPTION_MAX_CHARS,
  KNOWLEDGE_COLLECTION_NAME_MAX_CHARS,
  KNOWLEDGE_DISCOVERY_APPLY_MAX_URLS,
  KNOWLEDGE_DISCOVERY_DEFAULT_MAX_DEPTH,
  KNOWLEDGE_DISCOVERY_DEFAULT_MAX_URLS,
  KNOWLEDGE_DISCOVERY_MAX_DEPTH,
  KNOWLEDGE_DISCOVERY_MAX_URLS,
  KNOWLEDGE_ERROR_MESSAGES,
  KNOWLEDGE_SEARCH_FAILED_CODE,
  KNOWLEDGE_SEARCH_FAILED_MESSAGE,
  KNOWLEDGE_SOURCE_BULK_MAX_IDS,
} from '@seo/contracts';
import { logger } from '../logger.js';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { assertTransition } from './knowledgeLifecycle.js';
import { extractSourceText, normalizeText } from './knowledgeText.js';
import { chunkKnowledgeText } from '../knowledge/chunker.js';
import {
  computeFreshness,
  contentHash,
  nextRefreshAt,
  normalizeRefreshPolicy,
  refreshBackoffMs,
} from '../knowledge/freshness.js';
import {
  KNOWLEDGE_LIST_DEFAULT_LIMIT,
  KNOWLEDGE_LIST_MAX_LIMIT,
  KNOWLEDGE_MAX_EXTRACTED_CHARS,
  KNOWLEDGE_MAX_FILE_BYTES,
  KNOWLEDGE_PREVIEW_MAX_CHARS,
  KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS,
  KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
  KNOWLEDGE_SEARCH_MAX_CHARS,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  KNOWLEDGE_SEARCH_QUERY_MAX_CHARS,
  MAX_CHUNKS,
  MAX_NORMALIZED_CHARS,
} from '../knowledge/limits.js';
import { KnowledgeIngestError, isKnowledgeIngestError, type KnowledgeIngestErrorCode } from '../knowledge/errors.js';
import { validateExternalUrl } from '../knowledge/url.js';
import { isWithinScope, normalizeDiscoveryUrl } from '../knowledge/discovery.js';
import { hasValidSignature, resolveFileType, sanitizeFilename } from '../knowledge/files/fileTypes.js';

/** Largest single source body accepted for indexing (bytes/chars). Bounding it
 *  keeps chunking latency and Qdrant payloads sane for a UI/managed item. */
export const KNOWLEDGE_MAX_CHARS = 100_000;

/** Columns safe to expose in a list/detail DTO. Deliberately excludes
 *  `content_text` (large, private body) and `storage_path` (private object
 *  key) so neither can leak through a list response. */
const SOURCE_LIST_COLUMNS =
  'id, project_id, source_type, name, url, status, error, chunk_count, last_indexed_at, original_filename, content_type, size_bytes, collection_id, last_fetched_at, last_changed_at, next_refresh_at, refresh_policy, refresh_failures, created_at, updated_at, collection:seo_knowledge_collections(name)';

/** Columns for one collection row (never a raw row on the wire). */
const COLLECTION_COLUMNS = 'id, project_id, name, description, created_at, updated_at';

/** Columns safe to expose for a discovery session. `request_json` is excluded:
 *  the session DTO carries only the individual fields the UI renders. */
const DISCOVERY_SESSION_COLUMNS =
  'id, project_id, seed_url, normalized_seed_url, collection_id, status, scope, max_urls, max_depth, result_json, error, created_at, updated_at';

/** Fixed, allowlisted sort map. A client `sort` value can only select one of
 *  these pairs; no raw column name or SQL order ever reaches the database. */
const SOURCE_SORTS: Record<string, { column: string; ascending: boolean }> = {
  updated_desc: { column: 'updated_at', ascending: false },
  updated_asc: { column: 'updated_at', ascending: true },
  indexed_desc: { column: 'last_indexed_at', ascending: false },
  indexed_asc: { column: 'last_indexed_at', ascending: true },
  name_asc: { column: 'name', ascending: true },
  name_desc: { column: 'name', ascending: false },
};

/** Clamp a requested page size into [1, max]; non-finite falls back to default. */
function clampListLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return KNOWLEDGE_LIST_DEFAULT_LIMIT;
  return Math.min(KNOWLEDGE_LIST_MAX_LIMIT, Math.max(1, Math.floor(value)));
}

/** Clamp discovery `maxUrls` into [1, max]; absent/non-finite uses the default. */
export function clampDiscoveryMaxUrls(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return KNOWLEDGE_DISCOVERY_DEFAULT_MAX_URLS;
  return Math.max(1, Math.min(KNOWLEDGE_DISCOVERY_MAX_URLS, Math.floor(value)));
}

/** Clamp discovery `maxDepth` into [0, max]; absent/non-finite uses the default. */
export function clampDiscoveryMaxDepth(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return KNOWLEDGE_DISCOVERY_DEFAULT_MAX_DEPTH;
  return Math.max(0, Math.min(KNOWLEDGE_DISCOVERY_MAX_DEPTH, Math.floor(value)));
}

/**
 * Sanitize a metadata search term before it becomes a PostgREST `or` filter.
 * Characters with syntactic meaning in a filter (`%`, `*`, `,`, `(`, `)`, `\`)
 * and control characters are stripped, so a user can never inject a second
 * clause. The caller wraps the result in `%...%` for a case-insensitive match.
 */
export function sanitizeKnowledgeSearch(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/[,()%*\\]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, KNOWLEDGE_SEARCH_MAX_CHARS);
}

/**
 * Bounded plain-text preview of a source's stored body. File sources keep their
 * bytes in private storage and have no stored body, so they return null. The
 * text is data, never markup: the API returns it as-is and the UI renders it as
 * plain text.
 */
export function buildSourcePreview(row: SourceRow): KnowledgeSourcePreviewDto | null {
  const type = (row.source_type as KnowledgeSourceType | null) ?? 'text';
  if (type === 'file') return null;
  const raw = typeof row.content_text === 'string' ? row.content_text : '';
  if (!raw) return null;
  return {
    text: raw.slice(0, KNOWLEDGE_PREVIEW_MAX_CHARS),
    truncated: raw.length > KNOWLEDGE_PREVIEW_MAX_CHARS,
    characters: raw.length,
  };
}

export type SourceRow = Record<string, unknown>;

/** Credential reader the Qdrant provider never touches: knowledge indexing is
 *  configured from server env (QDRANT_* and EMBEDDINGS_* variables), not from
 *  stored per-project credentials, so we hand it a no-op to make that explicit. */
const NOOP_CREDENTIALS: ProviderContext['credentials'] = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
};

/** Stable Qdrant external id for a knowledge source. */
export function sourceExternalId(sourceId: string): string {
  return `source:${sourceId}`;
}

/**
 * Builds the provider document for one source row by running the type's
 * extractor + normalization. A source with no real text (a URL awaiting fetch,
 * a file awaiting parsing) is NOT indexed - there is no fabricated document,
 * because a made-up body would make an unfetched reference look searchable.
 * Returns null when there is nothing real to index.
 */
export function buildSourceDocument(row: SourceRow): KnowledgeDocumentInput | null {
  const extracted = extractSourceText(row);
  if (!extracted.ok) return null;
  const { text, title, url } = extracted.value;
  const id = typeof row.id === 'string' ? row.id : '';
  const type = (row.source_type as KnowledgeSourceType | null) ?? 'text';
  return {
    externalId: sourceExternalId(id),
    kind: 'note',
    title,
    text,
    url,
    collectionId: row.collection_id ? String(row.collection_id) : null,
    meta: { source: 'knowledge_source', source_type: type },
  };
}

/** Safe row -> DTO mapping: exposes status/error for honest reporting but
 *  never the raw body content, so source text is only reachable through the
 *  provider, never through this API. Freshness is derived here (never stored)
 *  so every read surface reports the same state. */
export function mapSourceRow(row: SourceRow, now: Date = new Date()): KnowledgeSourceDto {
  const sourceType = (row.source_type as KnowledgeSourceType) ?? 'text';
  const status = (row.status as KnowledgeSourceDto['status']) ?? 'queued';
  const collectionId = row.collection_id ? String(row.collection_id) : null;
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    source_type: sourceType,
    name: String(row.name ?? ''),
    url: row.url ? String(row.url) : null,
    status,
    error: row.error ? String(row.error) : null,
    chunk_count: Number(row.chunk_count ?? 0),
    last_indexed_at: row.last_indexed_at ? String(row.last_indexed_at) : null,
    original_filename: row.original_filename ? String(row.original_filename) : null,
    content_type: row.content_type ? String(row.content_type) : null,
    size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
    collection_id: collectionId,
    collection_name: collectionId ? embeddedCollectionName(row) : null,
    freshness: computeFreshness(
      {
        sourceType,
        status,
        refreshPolicy: row.refresh_policy,
        lastFetchedAt: row.last_fetched_at ? String(row.last_fetched_at) : null,
        lastChangedAt: row.last_changed_at ? String(row.last_changed_at) : null,
        nextRefreshAt: row.next_refresh_at ? String(row.next_refresh_at) : null,
        refreshFailures: Number(row.refresh_failures ?? 0),
      },
      now,
    ),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

/** Collection display name from a PostgREST embedding (`collection` may be a
 *  to-one object or a one-element array). Missing/unresolved is null, never a
 *  fabricated value. */
function embeddedCollectionName(row: SourceRow): string | null {
  const rel = row.collection;
  const obj = Array.isArray(rel) ? rel[0] : rel;
  if (obj && typeof obj === 'object') {
    const name = (obj as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

/** Safe collection row -> camelCase DTO. `description` is untrusted free text. */
export function mapCollectionRow(row: SourceRow, sourceCount: number): KnowledgeCollectionDto {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name ?? ''),
    description: row.description == null ? null : String(row.description),
    sourceCount,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

/**
 * Read the bounded candidate proposal out of a session row. The stored JSON is
 * always our own normalized shape, and only the allowlisted candidate fields are
 * projected - a raw provider payload could never reach the wire this way.
 */
function discoveryCandidates(row: SourceRow): KnowledgeDiscoveryCandidate[] {
  const result = row.result_json as { candidates?: unknown } | null | undefined;
  const raw = result && typeof result === 'object' ? (result as { candidates?: unknown }).candidates : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): KnowledgeDiscoveryCandidate[] => {
    if (!entry || typeof entry !== 'object') return [];
    const c = entry as Record<string, unknown>;
    const url = typeof c.url === 'string' ? c.url : '';
    const normalizedUrl = typeof c.normalizedUrl === 'string' ? c.normalizedUrl : url;
    if (!url) return [];
    return [
      {
        url,
        normalizedUrl,
        title: typeof c.title === 'string' ? c.title : null,
        depth: Number(c.depth ?? 0),
        discoveredFrom: typeof c.discoveredFrom === 'string' ? c.discoveredFrom : null,
        eligible: c.eligible === true,
        reason: typeof c.reason === 'string' ? (c.reason as KnowledgeDiscoveryReason) : null,
        alreadyExists: c.alreadyExists === true,
        existingSourceId: typeof c.existingSourceId === 'string' ? c.existingSourceId : null,
      },
    ];
  });
}

/** Safe discovery session row -> camelCase DTO (no stored request JSON). */
export function mapDiscoverySessionRow(row: SourceRow): KnowledgeDiscoverySessionDto {
  const candidates = discoveryCandidates(row);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    seedUrl: String(row.seed_url ?? ''),
    normalizedSeedUrl: String(row.normalized_seed_url ?? ''),
    collectionId: row.collection_id == null ? null : String(row.collection_id),
    status: (row.status as KnowledgeDiscoveryStatus) ?? 'queued',
    scope: (row.scope as KnowledgeDiscoveryScope) ?? 'same_host',
    maxUrls: Number(row.max_urls ?? KNOWLEDGE_DISCOVERY_DEFAULT_MAX_URLS),
    maxDepth: Number(row.max_depth ?? KNOWLEDGE_DISCOVERY_DEFAULT_MAX_DEPTH),
    candidateCount: candidates.length,
    eligibleCount: candidates.filter((c) => c.eligible).length,
    alreadyExistingCount: candidates.filter((c) => c.alreadyExists).length,
    errorCode: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

/** Session summary plus its bounded candidate list. */
export function mapDiscoverySessionDetailRow(row: SourceRow): KnowledgeDiscoverySessionDetailDto {
  return { ...mapDiscoverySessionRow(row), candidates: discoveryCandidates(row) };
}

/**
 * Boundary compatibility: legacy source-type input maps onto the canonical
 * vocabulary. Only the HTTP edge calls this; the database and services see
 * canonical values exclusively.
 */
const LEGACY_SOURCE_TYPES: Record<string, KnowledgeSourceType> = {
  note: 'text',
  reference: 'text',
};

export function normalizeSourceTypeInput(value: string): KnowledgeSourceType {
  return (LEGACY_SOURCE_TYPES[value] ?? value) as KnowledgeSourceType;
}

// ---------------------------------------------------------------------------
// Retrieval (KB6) - canonical, attributed, bounded search over the project
// knowledge base. Qdrant stays a ranking signal: scores are similarity scores,
// result content is untrusted plain text, and every hit must be attributable to
// a source or it is dropped (fail closed).
// ---------------------------------------------------------------------------

/** A validated retrieval request (the HTTP edge has already checked types). */
export interface KnowledgeSearchInput {
  query: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  sourceIds?: string[];
  /** Restrict to one collection (KB8) or, with `uncategorized`, to none. */
  collectionId?: string;
  uncategorized?: boolean;
}

/** Managed source ids live in the index as `source:<uuid>` external ids. */
const MANAGED_SOURCE_EXTERNAL_ID =
  /^source:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalize a retrieval query: control characters become spaces, runs of
 * whitespace collapse, and the result is hard-capped. Returns '' for a blank
 * query so the caller can reject it instead of searching for whitespace.
 */
export function normalizeSearchQuery(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, KNOWLEDGE_SEARCH_QUERY_MAX_CHARS);
}

/** Clamp a requested result count into [1, max]; non-finite falls back to default. */
export function clampSearchLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return KNOWLEDGE_SEARCH_DEFAULT_LIMIT;
  return Math.min(KNOWLEDGE_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(value)));
}

/** Managed source UUID from a hit's `source:<uuid>` external id, else null. */
export function managedSourceIdFromPayload(payload: Record<string, unknown>): string | null {
  const raw =
    typeof payload.source_id === 'string'
      ? payload.source_id
      : typeof payload.external_id === 'string'
        ? payload.external_id
        : '';
  const match = MANAGED_SOURCE_EXTERNAL_ID.exec(raw.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Bounded plain-text content of one hit. Retrieved content is untrusted data -
 * it is never interpreted as markup here and is always truncated server-side so
 * the browser can never receive an unbounded body through search. Returns null
 * when the hit carries no usable text.
 */
export function buildSearchContent(payload: Record<string, unknown>): string | null {
  const raw = typeof payload.text === 'string' ? payload.text : '';
  const text = raw.trim();
  if (!text) return null;
  return text.slice(0, KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS);
}

/** 0-based chunk index recorded by the provider, or null when absent. */
function searchChunkIndex(payload: Record<string, unknown>): number | null {
  const value = Number(payload.chunk_index);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Honest source type for a system-indexed hit: prefer the real type recorded in
 * `meta.source_type`, else infer from whether the indexed item has a URL. Never
 * fabricated - it reflects stored index metadata only.
 */
function searchSourceType(payload: Record<string, unknown>, url: string | null): KnowledgeSourceType {
  const meta = payload.meta as Record<string, unknown> | undefined;
  const metaType = meta && typeof meta.source_type === 'string' ? meta.source_type : '';
  if (metaType === 'text' || metaType === 'url' || metaType === 'file') return metaType;
  return url ? 'url' : 'text';
}

export interface KnowledgeCreateInput {
  sourceType?: KnowledgeSourceType;
  name: string;
  url?: string | null;
  text?: string | null;
}

/** Bytes + declared identity of an uploaded knowledge file (KB4). */
export interface KnowledgeFileCreateInput {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

type ProgressFn = (progress: number, message?: string) => Promise<void>;

export class KnowledgeService {
  private readonly sb: ServiceContainer['sb'];

  constructor(private readonly container: ServiceContainer) {
    this.sb = container.sb;
  }

  /** The registered Qdrant provider, or null when it is not on this server
   *  (reported as not configured rather than assumed present). */
  private knowledgeProvider(): KnowledgeProvider | null {
    return this.container.registry.getKnowledge('qdrant') ?? null;
  }

  /**
   * Null when knowledge is usable, otherwise a human reason it is not. Mirrors
   * exactly what the Qdrant provider itself requires (URL + API key + an
   * embedding key) so the UI never claims "configured" falsely.
   */
  configuredReason(): string | null {
    const env = this.container.config.env;
    if (!env.QDRANT_URL || !env.QDRANT_API_KEY) {
      return 'Set QDRANT_URL and QDRANT_API_KEY on the API server.';
    }
    const hasEmbeddingKey = Boolean(process.env.EMBEDDINGS_API_KEY || env.OPENAI_API_KEY);
    if (!hasEmbeddingKey) {
      return 'Add an embedding key on the API server (EMBEDDINGS_API_KEY or OPENAI_API_KEY).';
    }
    if (!this.knowledgeProvider()) {
      return 'The knowledge provider is not registered on this server.';
    }
    return null;
  }

  /** Load one source row strictly inside this project (404 otherwise) - the
   *  project_id filter is what keeps every later operation project-scoped. */
  private async sourceRow(projectId: string, sourceId: string): Promise<SourceRow> {
    const { data, error } = await this.sb
      .from('seo_knowledge_sources')
      .select('*, collection:seo_knowledge_collections(name)')
      .eq('project_id', projectId)
      .eq('id', sourceId)
      .maybeSingle();
    if (error || !data) throw ApiError.notFound('Knowledge source not found in this project');
    return data as SourceRow;
  }

  /**
   * Compare-and-swap a project-scoped row: apply `patch` only while the stored
   * status is one of `from`. Returns whether a row was changed, letting the
   * caller detect that a concurrent delete/ingest won the race and must not be
   * overwritten.
   */
  private async patchRow(
    projectId: string,
    sourceId: string,
    from: readonly KnowledgeSourceStatus[],
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const { data, error } = await this.sb
      .from('seo_knowledge_sources')
      .update(patch)
      .eq('project_id', projectId)
      .eq('id', sourceId)
      .in('status', [...from])
      .select('id');
    if (error) throw ApiError.badRequest('Could not update the knowledge source');
    return (data ?? []).length > 0;
  }

  /** Best-effort non-fatal error write; never throws. `fallback` is the stable
   *  code stored when `err` is a raw provider/transport error. */
  private async tryPatchError(projectId: string, sourceId: string, err: unknown, fallback?: string): Promise<void> {
    await this.patchRow(
      projectId,
      sourceId,
      ['queued', 'processing', 'ready', 'failed'],
      { status: 'failed', error: KnowledgeService.safeError(err, fallback) },
    ).catch(() => undefined);
  }

  /** Secret-free, bounded error text for the row's `error` column. Fetch/index
   *  failures from the pipeline are stored as their stable machine code (the UI
   *  maps codes to safe sentences via knowledgeErrorMessage); our own ApiErrors
   *  keep their message; a raw provider error becomes `fallback` when given, or
   *  a short bounded message otherwise. */
  private static safeError(err: unknown, fallback?: string): string {
    if (isKnowledgeIngestError(err)) return err.code;
    if (err instanceof ApiError) return err.message.slice(0, 400);
    if (fallback) return fallback;
    const message = err instanceof Error ? err.message : String(err);
    return message.slice(0, 400);
  }

  /** Turn a stable file error code into the wire-shaped ApiError the routes
   *  return, without duplicating the status/message mapping in every caller. */
  private static fileApiError(code: KnowledgeIngestErrorCode): ApiError {
    const err = new KnowledgeIngestError(code);
    return new ApiError(err.status, err.code, err.message);
  }

  /** Maps provider failures to clean ApiErrors; details never reach the client. */
  private static mapError(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    if (isKnowledgeIngestError(err)) {
      return new ApiError(err.status, err.code, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/not configured/i.test(message)) {
      return ApiError.notConfigured(
        'Knowledge is not configured on this server. Add QDRANT_URL/QDRANT_API_KEY and an embedding key to the API environment.',
      );
    }
    logger.error({ err }, 'knowledge source operation failed');
    return new ApiError(502, 'knowledge_index_failed', KNOWLEDGE_ERROR_MESSAGES.knowledge_index_failed);
  }

  /** ProviderContext handed to the Qdrant provider. Credentials are a no-op on
   *  purpose (see NOOP_CREDENTIALS) and the logger is namespaced per project so
   *  provider-side noise is attributable. */
  private context(projectId: string): ProviderContext {
    const child = logger.child({ projectId, provider: 'qdrant' });
    return {
      projectId,
      userId: null,
      config: {},
      credentials: NOOP_CREDENTIALS,
      logger: {
        info: (m: string, meta?: Record<string, unknown>) => child.info(meta ?? {}, m),
        warn: (m: string, meta?: Record<string, unknown>) => child.warn(meta ?? {}, m),
        error: (m: string, meta?: Record<string, unknown>) => child.error(meta ?? {}, m),
        debug: (m: string, meta?: Record<string, unknown>) => child.debug(meta ?? {}, m),
      },
    };
  }

  /**
   * List this project's knowledge sources with allowlisted filtering, metadata
   * search, sorting and bounded pagination, plus the project health summary.
   * `deleted` sources are hidden unless explicitly requested by status. Every
   * filter/sort value is resolved from a fixed map so no client input becomes
   * raw SQL, and the page size is always clamped.
   */
  async listSources(
    projectId: string,
    query: KnowledgeSourceListQuery = {},
  ): Promise<{ items: KnowledgeSourceDto[]; total: number; limit: number; offset: number; summary: KnowledgeSourceSummaryDto }> {
    const limit = clampListLimit(query.limit);
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const sort = SOURCE_SORTS[query.sort ?? 'updated_desc'] ?? SOURCE_SORTS.updated_desc;

    let q = this.sb
      .from('seo_knowledge_sources')
      .select(SOURCE_LIST_COLUMNS, { count: 'exact' })
      .eq('project_id', projectId);
    if (query.type) q = q.eq('source_type', query.type);
    if (query.status) q = q.eq('status', query.status);
    else q = q.neq('status', 'deleted');
    if (query.uncategorized) q = q.is('collection_id', null);
    else if (query.collection_id) q = q.eq('collection_id', query.collection_id);
    const term = sanitizeKnowledgeSearch(query.search);
    if (term) {
      q = q.or(`name.ilike.%${term}%,url.ilike.%${term}%,original_filename.ilike.%${term}%`);
    }
    const { data, error, count } = await q
      .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw ApiError.badRequest('Could not list knowledge sources');
    const items = ((data ?? []) as SourceRow[]).map((row) => mapSourceRow(row));
    const summary = await this.summarizeSources(projectId);
    return { items, total: count ?? items.length, limit, offset, summary };
  }

  /**
   * Project-level source health counts, computed from the source registry only
   * (never from Qdrant). Only non-deleted sources are counted; `total_chunks`
   * sums the indexed chunk counts so the UI can show whether the base is built.
   */
  async summarizeSources(projectId: string): Promise<KnowledgeSourceSummaryDto> {
    const { data, error } = await this.sb
      .from('seo_knowledge_sources')
      .select('status, chunk_count')
      .eq('project_id', projectId)
      .neq('status', 'deleted');
    if (error) throw ApiError.badRequest('Could not summarize knowledge sources');
    const summary: KnowledgeSourceSummaryDto = {
      total: 0,
      draft: 0,
      queued: 0,
      processing: 0,
      ready: 0,
      failed: 0,
      total_chunks: 0,
    };
    const countable: ReadonlyArray<'draft' | 'queued' | 'processing' | 'ready' | 'failed'> = [
      'draft',
      'queued',
      'processing',
      'ready',
      'failed',
    ];
    for (const row of (data ?? []) as Array<{ status?: string; chunk_count?: unknown }>) {
      summary.total += 1;
      if ((countable as readonly string[]).includes(row.status ?? '')) {
        summary[row.status as (typeof countable)[number]] += 1;
      }
      const chunks = Number(row.chunk_count ?? 0);
      if (Number.isFinite(chunks) && chunks > 0) summary.total_chunks += chunks;
    }
    return summary;
  }

  /**
   * One source with its safe detail surface. Strictly project-scoped (a source
   * from another project 404s rather than leaking its existence), and the
   * preview is bounded plain text - never the raw row, a storage path or a
   * parser error.
   */
  async getSourceDetail(projectId: string, sourceId: string): Promise<KnowledgeSourceDetailDto> {
    const row = await this.sourceRow(projectId, sourceId);
    return { ...mapSourceRow(row), preview: buildSourcePreview(row) };
  }

  /**
   * Change a URL source's refresh cadence (KB7). The next check is recomputed
   * from the last successful fetch so switching to `daily` on a week-old source
   * makes it immediately due, while `manual` clears the schedule. Non-URL and
   * deleted sources are refused - a policy is meaningless there.
   */
  async updateRefreshPolicy(
    projectId: string,
    sourceId: string,
    policy: KnowledgeRefreshPolicy,
  ): Promise<KnowledgeSourceDto> {
    const row = await this.sourceRow(projectId, sourceId);
    const status = (row.status as KnowledgeSourceStatus) ?? 'draft';
    if (status === 'deleted') throw ApiError.conflict('This source is being deleted.');
    if (((row.source_type as KnowledgeSourceType) ?? 'text') !== 'url') {
      throw ApiError.conflict('Refresh policies apply to URL sources only.');
    }

    const now = new Date();
    const lastFetched = typeof row.last_fetched_at === 'string' ? row.last_fetched_at : '';
    const base = lastFetched ? new Date(lastFetched) : now;
    const next = status === 'ready' && Number.isFinite(base.getTime()) ? nextRefreshAt(policy, base) : null;
    const committed = await this.patchRow(
      projectId,
      sourceId,
      ['draft', 'queued', 'processing', 'ready', 'failed'],
      { refresh_policy: policy, next_refresh_at: next },
    );
    if (!committed) throw ApiError.conflict('The source changed while updating its refresh policy. Try again.');
    return mapSourceRow(await this.sourceRow(projectId, sourceId));
  }

  /**
   * Bounded, project-scoped list of URL sources whose scheduled refresh is due.
   * Service-level capability that KB9/the scheduler will consume - there is no
   * public dashboard in KB7. Only `ready` sources with a real (non-manual)
   * policy and a due `next_refresh_at` are returned, oldest first.
   */
  async listDueRefreshes(projectId: string, limit = 50): Promise<KnowledgeDueRefreshDto[]> {
    const cap = Math.min(100, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 50)));
    const { data, error } = await this.sb
      .from('seo_knowledge_sources')
      .select('id, project_id, name, url, next_refresh_at, refresh_policy, refresh_failures')
      .eq('project_id', projectId)
      .eq('source_type', 'url')
      .eq('status', 'ready')
      .neq('refresh_policy', 'manual')
      .not('next_refresh_at', 'is', null)
      .lte('next_refresh_at', new Date().toISOString())
      .order('next_refresh_at', { ascending: true })
      .limit(cap);
    if (error) throw ApiError.badRequest('Could not list due knowledge refreshes');
    return ((data ?? []) as SourceRow[])
      .map((row) => {
        const policy = normalizeRefreshPolicy(row.refresh_policy);
        if (!policy || !row.next_refresh_at) return null;
        return {
          id: String(row.id),
          project_id: String(row.project_id),
          name: String(row.name ?? ''),
          url: row.url ? String(row.url) : null,
          next_refresh_at: String(row.next_refresh_at),
          refresh_policy: policy,
          refresh_failures: Number(row.refresh_failures ?? 0),
        } satisfies KnowledgeDueRefreshDto;
      })
      .filter((row): row is KnowledgeDueRefreshDto => row !== null);
  }

  // -------------------------------------------------------------------------
  // Knowledge collections (KB8) - optional organizational metadata. These
  // methods never touch lifecycle, freshness or vectors; assigning a source to
  // a collection is a metadata write only (and, when a provider supports it, an
  // in-place payload update - never a re-index).
  // -------------------------------------------------------------------------

  /** Load one collection row strictly inside this project (404 otherwise). */
  private async collectionRow(projectId: string, collectionId: string): Promise<SourceRow> {
    const { data, error } = await this.sb
      .from('seo_knowledge_collections')
      .select(COLLECTION_COLUMNS)
      .eq('project_id', projectId)
      .eq('id', collectionId)
      .maybeSingle();
    if (error || !data) throw ApiError.notFound('Knowledge collection not found in this project');
    return data as SourceRow;
  }

  /** Count non-deleted sources per collection for the given ids (one query). */
  private async sourceCountsByCollection(projectId: string, ids: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (ids.length === 0) return counts;
    const { data, error } = await this.sb
      .from('seo_knowledge_sources')
      .select('collection_id')
      .eq('project_id', projectId)
      .in('collection_id', ids)
      .neq('status', 'deleted');
    if (error) throw ApiError.badRequest('Could not count collection sources');
    for (const row of (data ?? []) as SourceRow[]) {
      const id = row.collection_id ? String(row.collection_id) : '';
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  /** Map a Supabase write error to a safe ApiError (unique name -> conflict). */
  private static collectionWriteError(error: { code?: string; message?: string }): ApiError {
    if (error.code === '23505') return ApiError.conflict('A collection with that name already exists.');
    return ApiError.badRequest('Could not save the knowledge collection');
  }

  /**
   * Bounded, deterministically ordered list of this project's collections with
   * a per-collection source count. Never unbounded and never a raw row.
   */
  async listCollections(
    projectId: string,
    query: { limit?: number; offset?: number } = {},
  ): Promise<KnowledgeCollectionsResponse> {
    const limit = clampListLimit(query.limit);
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const { data, error, count } = await this.sb
      .from('seo_knowledge_collections')
      .select(COLLECTION_COLUMNS, { count: 'exact' })
      .eq('project_id', projectId)
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw ApiError.badRequest('Could not list knowledge collections');
    const rows = (data ?? []) as SourceRow[];
    const counts = await this.sourceCountsByCollection(projectId, rows.map((r) => String(r.id)));
    const items = rows.map((row) => mapCollectionRow(row, counts.get(String(row.id)) ?? 0));
    return { items, total: count ?? items.length, limit, offset };
  }

  /** One collection plus a bounded, update-first page of its sources. */
  async getCollectionDetail(
    projectId: string,
    collectionId: string,
    query: { limit?: number; offset?: number } = {},
  ): Promise<KnowledgeCollectionDetailDto> {
    const row = await this.collectionRow(projectId, collectionId);
    const limit = clampListLimit(query.limit);
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const { data, error, count } = await this.sb
      .from('seo_knowledge_sources')
      .select(SOURCE_LIST_COLUMNS, { count: 'exact' })
      .eq('project_id', projectId)
      .eq('collection_id', collectionId)
      .neq('status', 'deleted')
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw ApiError.badRequest('Could not load the collection sources');
    const items = ((data ?? []) as SourceRow[]).map((source) => mapSourceRow(source));
    const total = count ?? items.length;
    return { ...mapCollectionRow(row, total), items, total, limit, offset };
  }

  /** Create a collection (editor+). Name is trimmed and uniqueness is enforced
   *  case-insensitively; a duplicate is a clean conflict, never a raw SQL error. */
  async createCollection(
    projectId: string,
    userId: string,
    input: { name: string; description?: string | null },
  ): Promise<KnowledgeCollectionDto> {
    const name = KnowledgeService.validCollectionName(input.name);
    const description = KnowledgeService.normalizeCollectionDescription(input.description);
    const { data, error } = await this.sb
      .from('seo_knowledge_collections')
      .insert({ project_id: projectId, name, description, created_by: userId })
      .select(COLLECTION_COLUMNS)
      .single();
    if (error || !data) throw KnowledgeService.collectionWriteError(error ?? {});
    return mapCollectionRow(data as SourceRow, 0);
  }

  /** Rename / re-describe a collection (editor+). Omitted fields are untouched. */
  async updateCollection(
    projectId: string,
    collectionId: string,
    input: { name?: string; description?: string | null },
  ): Promise<KnowledgeCollectionDto> {
    await this.collectionRow(projectId, collectionId);
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = KnowledgeService.validCollectionName(input.name);
    if ('description' in input) patch.description = KnowledgeService.normalizeCollectionDescription(input.description);
    if (Object.keys(patch).length === 0) throw ApiError.badRequest('Nothing to update.');
    const { data, error } = await this.sb
      .from('seo_knowledge_collections')
      .update(patch)
      .eq('project_id', projectId)
      .eq('id', collectionId)
      .select(COLLECTION_COLUMNS)
      .single();
    if (error || !data) throw KnowledgeService.collectionWriteError(error ?? {});
    const counts = await this.sourceCountsByCollection(projectId, [collectionId]);
    return mapCollectionRow(data as SourceRow, counts.get(collectionId) ?? 0);
  }

  /**
   * Delete a collection (editor+). Sources are deliberately NOT deleted: the
   * FK's ON DELETE SET NULL returns them to uncategorized, where they remain
   * fully searchable. Returns the deleted id so the UI can confirm the outcome.
   */
  async deleteCollection(projectId: string, collectionId: string): Promise<{ id: string; deleted: true }> {
    await this.collectionRow(projectId, collectionId);
    const { error } = await this.sb
      .from('seo_knowledge_collections')
      .delete()
      .eq('project_id', projectId)
      .eq('id', collectionId);
    if (error) throw ApiError.badRequest('Could not delete the knowledge collection');
    return { id: collectionId, deleted: true };
  }

  private static validCollectionName(raw: string | undefined): string {
    const name = (raw ?? '').trim();
    if (!name) throw ApiError.badRequest('Give the collection a name.');
    if (name.length > KNOWLEDGE_COLLECTION_NAME_MAX_CHARS) {
      throw ApiError.badRequest(`Collection name is too long (max ${KNOWLEDGE_COLLECTION_NAME_MAX_CHARS} characters).`);
    }
    return name;
  }

  private static normalizeCollectionDescription(raw: string | null | undefined): string | null {
    const description = (raw ?? '').trim();
    if (!description) return null;
    if (description.length > KNOWLEDGE_COLLECTION_DESCRIPTION_MAX_CHARS) {
      throw ApiError.badRequest(
        `Collection description is too long (max ${KNOWLEDGE_COLLECTION_DESCRIPTION_MAX_CHARS} characters).`,
      );
    }
    return description;
  }

  /**
   * Mirror a source's collection onto its existing vectors without re-embedding
   * (KB8). Postgres stays authoritative: if the provider cannot sync (absent or
   * failing) the registry is still correct and the next index run reconciles the
   * payload, so this is logged, never surfaced as a failure of the assignment.
   */
  private async syncCollectionMetadata(
    projectId: string,
    sourceId: string,
    collectionId: string | null,
  ): Promise<void> {
    const provider = this.knowledgeProvider();
    if (!provider?.updateMetadata) return;
    try {
      await provider.updateMetadata(this.context(projectId), sourceExternalId(sourceId), {
        collection_id: collectionId,
      });
    } catch (err) {
      logger.warn({ err, projectId, sourceId }, 'knowledge collection metadata sync failed; registry remains authoritative');
    }
  }

  /** Validate that a collection id is a real collection in this project. */
  private async resolveCollectionTarget(projectId: string, collectionId: string): Promise<string> {
    const id = collectionId.trim();
    if (!UUID.test(id)) throw ApiError.badRequest('Invalid collection id');
    await this.collectionRow(projectId, id);
    return id;
  }

  /**
   * Assign one source to a collection, or remove it (null) so it becomes
   * uncategorized. Metadata only: lifecycle, freshness and vectors are never
   * changed, and cross-project collections are refused.
   */
  async assignCollection(
    projectId: string,
    sourceId: string,
    collectionId: string | null,
  ): Promise<KnowledgeSourceDto> {
    const row = await this.sourceRow(projectId, sourceId);
    if (((row.status as KnowledgeSourceStatus) ?? 'draft') === 'deleted') {
      throw ApiError.conflict('This source is being deleted.');
    }
    const target = collectionId === null ? null : await this.resolveCollectionTarget(projectId, collectionId);
    const { error } = await this.sb
      .from('seo_knowledge_sources')
      .update({ collection_id: target })
      .eq('project_id', projectId)
      .eq('id', sourceId);
    if (error) throw ApiError.badRequest('Could not update the source collection');
    await this.syncCollectionMetadata(projectId, sourceId, target);
    return mapSourceRow(await this.sourceRow(projectId, sourceId));
  }

  /**
   * Move a bounded set of sources into a collection (or out of any collection
   * with null) atomically and fail-closed: every id must be a non-deleted
   * source in this project and the target must belong to it, otherwise nothing
   * is changed. One UPDATE statement applies the whole batch.
   */
  async bulkAssignCollection(
    projectId: string,
    sourceIds: string[],
    collectionId: string | null,
  ): Promise<{ updated: number; collectionId: string | null }> {
    const ids = [...new Set(sourceIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) throw ApiError.badRequest('Select at least one source.');
    if (ids.length > KNOWLEDGE_SOURCE_BULK_MAX_IDS) {
      throw ApiError.badRequest(`Too many sources selected (max ${KNOWLEDGE_SOURCE_BULK_MAX_IDS}).`);
    }
    if (ids.some((id) => !UUID.test(id))) throw ApiError.badRequest('Invalid source id');
    const target = collectionId === null ? null : await this.resolveCollectionTarget(projectId, collectionId);

    const { data, error } = await this.sb
      .from('seo_knowledge_sources')
      .select('id, status')
      .eq('project_id', projectId)
      .in('id', ids);
    if (error) throw ApiError.badRequest('Could not resolve the selected sources');
    const found = new Map(((data ?? []) as SourceRow[]).map((row) => [String(row.id), row]));
    if (ids.some((id) => !found.has(id))) {
      throw ApiError.badRequest('Some selected sources are not in this project.');
    }
    if (ids.some((id) => String(found.get(id)?.status ?? '') === 'deleted')) {
      throw ApiError.conflict('Some selected sources are being deleted.');
    }

    const { error: updateError } = await this.sb
      .from('seo_knowledge_sources')
      .update({ collection_id: target })
      .eq('project_id', projectId)
      .in('id', ids);
    if (updateError) throw ApiError.badRequest('Could not update the selected sources');
    await Promise.all(ids.map((id) => this.syncCollectionMetadata(projectId, id, target)));
    return { updated: ids.length, collectionId: target };
  }

  // -------------------------------------------------------------------------
  // Knowledge discovery (KB9) - controlled, human-approved link discovery.
  //
  // The service is the policy owner: it validates the seed, bounds the run,
  // normalizes/dedupes/scopes every discovered URL, marks eligibility and
  // existing sources, and (only on an explicit human selection) creates normal
  // URL sources and queues the existing KB3 ingestion. The provider only
  // fetches and extracts links; it never decides what becomes knowledge.
  // -------------------------------------------------------------------------

  private async discoverySessionRow(projectId: string, sessionId: string): Promise<SourceRow> {
    const { data } = await this.sb
      .from('seo_knowledge_discovery_sessions')
      .select(DISCOVERY_SESSION_COLUMNS)
      .eq('project_id', projectId)
      .eq('id', sessionId)
      .maybeSingle();
    if (!data) throw ApiError.notFound('Discovery session not found');
    return data as SourceRow;
  }

  /** Compare-and-swap a session's status; false when no row matched. */
  private async patchDiscoveryRow(
    projectId: string,
    sessionId: string,
    statuses: KnowledgeDiscoveryStatus[],
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const { data, error } = await this.sb
      .from('seo_knowledge_discovery_sessions')
      .update(patch)
      .eq('project_id', projectId)
      .eq('id', sessionId)
      .in('status', statuses)
      .select('id');
    if (error) throw ApiError.badRequest('Could not update the discovery session');
    return Array.isArray(data) ? data.length > 0 : Boolean(data);
  }

  private async failDiscovery(projectId: string, sessionId: string, code: string): Promise<void> {
    await this.patchDiscoveryRow(projectId, sessionId, ['queued', 'processing'], { status: 'failed', error: code }).catch(
      () => undefined,
    );
  }

  /** Normalized-URL -> existing source id for this project (non-deleted only). */
  private async existingUrlSourceMap(projectId: string): Promise<Map<string, string>> {
    const { data, error } = await this.sb
      .from('seo_knowledge_sources')
      .select('id, url')
      .eq('project_id', projectId)
      .eq('source_type', 'url')
      .neq('status', 'deleted');
    if (error) throw ApiError.badRequest('Could not check existing knowledge sources');
    const map = new Map<string, string>();
    for (const row of (data ?? []) as SourceRow[]) {
      const url = typeof row.url === 'string' ? row.url.trim() : '';
      if (!url) continue;
      try {
        map.set(normalizeDiscoveryUrl(url), String(row.id));
      } catch {
        // A legacy/never-fetchable URL cannot participate in de-duplication.
      }
    }
    return map;
  }

  /**
   * Project a provider link list onto the bounded candidate model: normalize,
   * de-duplicate, scope-check, re-validate and mark existing sources. Ordering
   * is stable and deterministic (depth, then discovery order, then URL).
   */
  private async buildDiscoveryCandidates(
    projectId: string,
    seedUrl: string,
    scope: KnowledgeDiscoveryScope,
    links: Array<{ url: string; title?: string; depth: number; discoveredFrom?: string }>,
  ): Promise<KnowledgeDiscoveryCandidate[]> {
    const seedHost = new URL(seedUrl).hostname;
    const existing = await this.existingUrlSourceMap(projectId);
    const seen = new Set<string>();
    const candidates: KnowledgeDiscoveryCandidate[] = [];

    for (const link of links) {
      let normalized: string | null = null;
      try {
        normalized = normalizeDiscoveryUrl(link.url);
      } catch {
        normalized = null;
      }

      let reason: KnowledgeDiscoveryReason | null = null;
      if (!normalized) {
        reason = 'url_not_allowed';
      } else if (seen.has(normalized)) {
        continue;
      } else {
        seen.add(normalized);
        if (!isWithinScope(seedHost, new URL(normalized).hostname, scope)) reason = 'out_of_scope';
      }

      const existingId = normalized ? existing.get(normalized) ?? null : null;
      if (existingId) reason = 'duplicate';
      candidates.push({
        url: link.url,
        normalizedUrl: normalized ?? link.url.slice(0, 2048),
        title: link.title ?? null,
        depth: link.depth,
        discoveredFrom: link.discoveredFrom ?? null,
        eligible: reason === null,
        reason,
        alreadyExists: existingId !== null,
        existingSourceId: existingId,
      });
    }

    return candidates
      .map((candidate, order) => ({ candidate, order }))
      .sort(
        (a, b) =>
          a.candidate.depth - b.candidate.depth ||
          a.order - b.order ||
          a.candidate.normalizedUrl.localeCompare(b.candidate.normalizedUrl),
      )
      .map((entry) => entry.candidate);
  }

  /**
   * Start a discovery session: validate the seed through the SSRF guard, resolve
   * an optional collection target, persist a bounded request row and queue the
   * background discovery job. No network fetch happens here.
   */
  async startDiscovery(projectId: string, userId: string, input: KnowledgeDiscoveryRequest) {
    const reason = this.configuredReason();
    if (reason) throw ApiError.notConfigured(`Knowledge discovery is not configured. ${reason}`);
    const provider = this.container.knowledgeDiscoveryProvider;
    if (!provider || !provider.isConfigured()) {
      throw ApiError.notConfigured('Knowledge discovery is not configured on this server.');
    }

    const rawSeed = (input.seedUrl ?? '').trim();
    if (!rawSeed) throw ApiError.badRequest('Provide a seed URL to discover from.');
    let seedUrl: string;
    let normalizedSeedUrl: string;
    try {
      seedUrl = validateExternalUrl(rawSeed).toString();
      normalizedSeedUrl = normalizeDiscoveryUrl(seedUrl);
    } catch (err) {
      if (isKnowledgeIngestError(err)) throw new ApiError(err.status, err.code, err.message);
      throw err;
    }

    const collectionId = input.collectionId ? await this.resolveCollectionTarget(projectId, input.collectionId) : null;
    const scope: KnowledgeDiscoveryScope = input.scope === 'same_domain' ? 'same_domain' : 'same_host';
    const maxUrls = clampDiscoveryMaxUrls(input.maxUrls);
    const maxDepth = clampDiscoveryMaxDepth(input.maxDepth);

    const { data, error } = await this.sb
      .from('seo_knowledge_discovery_sessions')
      .insert({
        project_id: projectId,
        seed_url: seedUrl,
        normalized_seed_url: normalizedSeedUrl,
        collection_id: collectionId,
        status: 'queued',
        scope,
        max_urls: maxUrls,
        max_depth: maxDepth,
        request_json: { seedUrl, scope, maxUrls, maxDepth, collectionId },
        created_by: userId,
      })
      .select(DISCOVERY_SESSION_COLUMNS)
      .single();
    if (error || !data) throw ApiError.badRequest('Could not start the discovery session');
    const inserted = data as SourceRow;

    try {
      const job = await this.container.jobStore.enqueue({
        project_id: projectId,
        provider: 'qdrant',
        job_type: 'knowledge_discovery',
        params: { session_id: String(inserted.id) },
        created_by: userId,
      });
      return { session: mapDiscoverySessionRow(inserted), job };
    } catch (err) {
      // Never leave a session stuck in `queued` when the queue refused the job.
      await this.patchDiscoveryRow(projectId, String(inserted.id), ['queued'], {
        status: 'failed',
        error: 'knowledge_fetch_provider_error',
      }).catch(() => undefined);
      throw err;
    }
  }

  /** One session plus its bounded candidate proposal. */
  async getDiscoverySession(projectId: string, sessionId: string): Promise<KnowledgeDiscoverySessionDetailDto> {
    return mapDiscoverySessionDetailRow(await this.discoverySessionRow(projectId, sessionId));
  }

  /**
   * Run discovery for one session (worker executor). Claims the row, runs the
   * bounded provider, builds the candidate proposal and commits it. The seed
   * fetch failing fails the session honestly; individual unreachable discovered
   * pages are skipped by the provider and never become fabricated candidates.
   */
  async runDiscovery(projectId: string, sessionId: string, report?: ProgressFn): Promise<Record<string, unknown>> {
    let row: SourceRow;
    try {
      row = await this.discoverySessionRow(projectId, sessionId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return { session_id: sessionId, skipped: true, message: 'Discovery session no longer exists' };
      }
      throw err;
    }
    if ((row.status as KnowledgeDiscoveryStatus) === 'applied') {
      return { session_id: sessionId, skipped: true, message: 'Session was already applied' };
    }

    const provider = this.container.knowledgeDiscoveryProvider;
    if (!provider || !provider.isConfigured()) {
      await this.failDiscovery(projectId, sessionId, 'knowledge_jina_not_configured');
      throw new ApiError(503, 'knowledge_jina_not_configured', KNOWLEDGE_ERROR_MESSAGES.knowledge_jina_not_configured);
    }

    const claimed = await this.patchDiscoveryRow(projectId, sessionId, ['queued', 'processing', 'failed'], {
      status: 'processing',
      error: null,
    });
    if (!claimed) return { session_id: sessionId, skipped: true, message: 'Session is not discoverable right now' };

    try {
      const seedUrl = String(row.seed_url);
      const scope = (row.scope as KnowledgeDiscoveryScope) ?? 'same_host';
      await report?.(10, 'Fetching the seed page');
      const result = await provider.discover(seedUrl, {
        maxUrls: clampDiscoveryMaxUrls(Number(row.max_urls)),
        maxDepth: clampDiscoveryMaxDepth(Number(row.max_depth)),
        scope,
      });
      await report?.(60, 'Checking existing sources');
      const candidates = await this.buildDiscoveryCandidates(projectId, seedUrl, scope, result.links);
      const committed = await this.patchDiscoveryRow(projectId, sessionId, ['processing'], {
        status: 'ready',
        error: null,
        result_json: { candidates, seedTitle: result.seedTitle ?? null },
      });
      if (!committed) return { session_id: sessionId, skipped: true, message: 'Session changed during discovery' };
      await report?.(100, `Found ${candidates.length} candidate URL(s)`);
      return {
        session_id: sessionId,
        candidates: candidates.length,
        eligible: candidates.filter((c) => c.eligible).length,
      };
    } catch (err) {
      const code = isKnowledgeIngestError(err) ? err.code : 'knowledge_fetch_provider_error';
      await this.failDiscovery(projectId, sessionId, code);
      throw err;
    }
  }

  /**
   * Apply a human selection from a `ready` session. Every requested URL must be
   * a candidate of *this* session; URLs are re-validated, duplicates are
   * skipped and each created source is committed before its existing KB3
   * ingestion is queued. Re-running an apply is safe: already-created sources
   * are reported as `already_exists`, never duplicated.
   */
  async applyDiscovery(
    projectId: string,
    userId: string,
    sessionId: string,
    urls: string[],
  ): Promise<KnowledgeDiscoveryApplyResultDto> {
    const row = await this.discoverySessionRow(projectId, sessionId);
    const status = (row.status as KnowledgeDiscoveryStatus) ?? 'queued';
    if (status === 'queued' || status === 'processing') {
      throw ApiError.conflict('Discovery is still running. Wait for it to finish.');
    }
    if (status === 'failed') throw ApiError.conflict('This discovery session failed. Start a new one.');

    const candidates = discoveryCandidates(row);
    const byKey = new Map<string, KnowledgeDiscoveryCandidate>();
    for (const candidate of candidates) {
      byKey.set(candidate.normalizedUrl, candidate);
      byKey.set(candidate.url, candidate);
    }

    const requested = [...new Set((urls ?? []).map((value) => String(value).trim()).filter(Boolean))];
    if (requested.length === 0) throw ApiError.badRequest('Select at least one URL to add.');
    if (requested.length > KNOWLEDGE_DISCOVERY_APPLY_MAX_URLS) {
      throw ApiError.badRequest(`Too many URLs selected (max ${KNOWLEDGE_DISCOVERY_APPLY_MAX_URLS}).`);
    }

    const collectionId = row.collection_id == null ? null : String(row.collection_id);
    const existing = await this.existingUrlSourceMap(projectId);
    const seen = new Set<string>();
    const items: KnowledgeDiscoveryApplyItem[] = [];
    let created = 0;
    let alreadyExists = 0;
    let queued = 0;
    let rejected = 0;

    const reject = (url: string, normalizedUrl: string, reason: string) => {
      rejected += 1;
      items.push({ url, normalizedUrl, outcome: 'rejected', sourceId: null, reason });
    };
    const exists = (url: string, normalizedUrl: string, sourceId: string) => {
      alreadyExists += 1;
      items.push({ url, normalizedUrl, outcome: 'already_exists', sourceId, reason: 'duplicate' });
    };

    for (const raw of requested) {
      const candidate = byKey.get(raw);
      if (!candidate) {
        reject(raw, raw, 'not_a_candidate');
        continue;
      }
      const normalized = candidate.normalizedUrl;
      if (seen.has(normalized)) {
        reject(raw, normalized, 'duplicate');
        continue;
      }
      seen.add(normalized);

      // Re-validate every URL at apply time: the SSRF guard is the last gate
      // before a source is created, and scope/eligibility is re-checked.
      try {
        normalizeDiscoveryUrl(normalized);
      } catch {
        reject(raw, normalized, 'url_not_allowed');
        continue;
      }
      if (!candidate.eligible) {
        if (candidate.alreadyExists && candidate.existingSourceId) {
          exists(raw, normalized, candidate.existingSourceId);
        } else {
          reject(raw, normalized, candidate.reason ?? 'rejected');
        }
        continue;
      }
      const existingId = existing.get(normalized);
      if (existingId) {
        exists(raw, normalized, existingId);
        continue;
      }

      const name = KnowledgeService.discoverySourceName(candidate, normalized);
      const { data: inserted, error } = await this.sb
        .from('seo_knowledge_sources')
        .insert({
          project_id: projectId,
          source_type: 'url',
          name,
          url: normalized,
          content_text: null,
          status: 'draft',
          chunk_count: 0,
          refresh_policy: 'manual',
          collection_id: collectionId,
          created_by: userId,
        })
        .select('id')
        .single();
      if (error || !inserted) {
        reject(raw, normalized, 'create_failed');
        continue;
      }
      const sourceId = String((inserted as SourceRow).id);
      existing.set(normalized, sourceId);
      created += 1;
      try {
        await this.enqueueIngest(projectId, sourceId, userId);
        queued += 1;
        items.push({ url: raw, normalizedUrl: normalized, outcome: 'created', sourceId, reason: null });
      } catch {
        items.push({ url: raw, normalizedUrl: normalized, outcome: 'created', sourceId, reason: 'ingest_not_queued' });
      }
    }

    await this.patchDiscoveryRow(projectId, sessionId, [status], { status: 'applied' });
    return { created, alreadyExists, queued, rejected, items };
  }

  /** Best-effort display name for a discovered source: title, else host + path. */
  private static discoverySourceName(candidate: KnowledgeDiscoveryCandidate, normalized: string): string {
    const title = (candidate.title ?? '').trim();
    if (title) return title.slice(0, 200);
    try {
      const url = new URL(normalized);
      const path = url.pathname === '/' ? '' : url.pathname;
      return `${url.hostname}${path}`.slice(0, 200) || url.hostname;
    } catch {
      return normalized.slice(0, 200);
    }
  }

  /**
   * Canonical retrieval (KB6): one bounded, attributed result envelope for the
   * API, the Search Explorer and the writer. The query is normalized, the limit
   * is clamped, and filters are projected onto the provider's allowlisted shape
   * - no raw client filter ever reaches Qdrant. Raw provider hits are then
   * mapped to attributed results; a hit without a real source identity is
   * dropped rather than invented. Diagnostics are measured inside this boundary
   * only (never a raw provider payload).
   */
  async search(projectId: string, input: KnowledgeSearchInput): Promise<KnowledgeSearchResponse> {
    const reason = this.configuredReason();
    if (reason) throw ApiError.notConfigured(`Knowledge search is not available. ${reason}`);
    const provider = this.knowledgeProvider();
    if (!provider) throw ApiError.notConfigured('The knowledge provider is not registered on this server.');

    const query = normalizeSearchQuery(input.query);
    if (!query) throw ApiError.badRequest('Enter a search query.');
    const limit = clampSearchLimit(input.limit);
    const filter = KnowledgeService.buildSearchFilter(input);

    const started = Date.now();
    let hits: KnowledgeSearchResult[];
    try {
      hits = await provider.search({ projectId, query, limit, filter });
    } catch (err) {
      throw KnowledgeService.mapSearchError(err);
    }
    const searchDurationMs = Date.now() - started;

    const results = await this.attributeSearchHits(projectId, hits);
    return {
      project_id: projectId,
      query,
      limit,
      results,
      diagnostics: {
        result_count: results.length,
        provider: provider.id,
        search_duration_ms: searchDurationMs,
      },
    };
  }

  /**
   * Project a validated request onto the provider filter allowlist. Source ids
   * are the project's source UUIDs; they are mapped to the `source:<id>` index
   * key. Anything else is ignored rather than forwarded, and an invalid id is a
   * bad request instead of a silently broadened search.
   */
  private static buildSearchFilter(input: KnowledgeSearchInput): KnowledgeSearchFilter | undefined {
    const filter: KnowledgeSearchFilter = {};
    const sourceTypes = [...new Set(input.sourceTypes ?? [])];
    if (sourceTypes.length > 0) filter.sourceTypes = sourceTypes;
    const ids = [...new Set((input.sourceIds ?? []).map((id) => id.trim()).filter(Boolean))];
    if (ids.some((id) => !UUID.test(id))) throw ApiError.badRequest('Invalid source id filter');
    if (ids.length > 0) filter.sourceIds = ids.map(sourceExternalId);
    if (input.collectionId) {
      const collectionId = input.collectionId.trim();
      if (!UUID.test(collectionId)) throw ApiError.badRequest('Invalid collection id filter');
      filter.collectionId = collectionId;
    } else if (input.uncategorized) {
      filter.uncategorized = true;
    }
    return Object.keys(filter).length > 0 ? filter : undefined;
  }

  /**
   * Attribute raw provider hits to Knowledge Sources. Managed sources
   * (`source:<uuid>`) are resolved against this project's registry so the name
   * and type are authoritative; a hit whose managed source is missing from the
   * project or is no longer freshly indexed is dropped (fail closed, no
   * cross-project or stale leak). System-indexed knowledge is attributed from
   * the hit's own safe metadata, never from a vector point id.
   */
  private async attributeSearchHits(
    projectId: string,
    hits: KnowledgeSearchResult[],
  ): Promise<KnowledgeSearchHitDto[]> {
    const managedIds = [
      ...new Set(
        hits.map((h) => managedSourceIdFromPayload(h.payload)).filter((id): id is string => Boolean(id)),
      ),
    ];
    const rows = new Map<string, SourceRow>();
    if (managedIds.length > 0) {
      const { data, error } = await this.sb
        .from('seo_knowledge_sources')
        .select('id, name, source_type, url, status, collection_id, collection:seo_knowledge_collections(name)')
        .eq('project_id', projectId)
        .in('id', managedIds);
      if (error) throw ApiError.badRequest('Could not attribute knowledge results');
      for (const row of (data ?? []) as SourceRow[]) rows.set(String(row.id), row);
    }

    const results: KnowledgeSearchHitDto[] = [];
    for (const hit of hits) {
      const score = Number(hit.score);
      if (!Number.isFinite(score)) continue;
      const content = buildSearchContent(hit.payload);
      if (!content) continue;
      const payload = hit.payload;

      const managedId = managedSourceIdFromPayload(payload);
      if (managedId) {
        const row = rows.get(managedId);
        if (!row || String(row.status ?? '') !== 'ready') continue;
        results.push({
          source_id: managedId,
          source_name: String(row.name ?? '').trim() || managedId,
          source_type: (row.source_type as KnowledgeSourceType) ?? 'text',
          source_url: typeof row.url === 'string' && row.url.trim() ? row.url.trim() : null,
          managed: true,
          collection_id: row.collection_id ? String(row.collection_id) : null,
          collection_name: row.collection_id ? embeddedCollectionName(row) : null,
          chunk_index: searchChunkIndex(payload),
          content,
          score,
        });
        continue;
      }

      const sourceId = typeof payload.source_id === 'string' ? payload.source_id.trim() : '';
      const name = typeof payload.title === 'string' ? payload.title.trim() : '';
      if (!sourceId || !name) continue;
      const url = typeof payload.url === 'string' && payload.url.trim() ? payload.url.trim() : null;
      results.push({
        source_id: sourceId,
        source_name: name,
        source_type: searchSourceType(payload, url),
        source_url: url,
        managed: false,
        collection_id: null,
        collection_name: null,
        chunk_index: searchChunkIndex(payload),
        content,
        score,
      });
    }
    return results;
  }

  /** Maps retrieval failures to clean ApiErrors; provider internals never leak. */
  private static mapSearchError(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    if (isKnowledgeIngestError(err)) return new ApiError(err.status, err.code, err.message);
    const message = err instanceof Error ? err.message : String(err);
    if (/not configured/i.test(message)) {
      return ApiError.notConfigured('Knowledge search is not configured on this server.');
    }
    logger.error({ err }, 'knowledge search failed');
    return new ApiError(502, KNOWLEDGE_SEARCH_FAILED_CODE, KNOWLEDGE_SEARCH_FAILED_MESSAGE);
  }

  /**
   * Validates input and inserts a source row in `draft`, then queues ingestion
   * when the source is immediately indexable. A `text` source (or a `url`
   * source the user also pasted content for) becomes `queued`; a bare `url`
   * source stays `draft` because URL fetching does not exist yet - pretending
   * it is indexed would be dishonest. `file` is rejected until KB4. Vectors are
   * written by the worker, never here.
   */
  async createSource(projectId: string, userId: string, input: KnowledgeCreateInput) {
    const reason = this.configuredReason();
    if (reason) {
      throw ApiError.notConfigured(`Knowledge is not configured on this server. ${reason}`);
    }
    const name = (input.name ?? '').trim();
    const url = input.url?.trim() ? input.url.trim() : null;
    const text = input.text?.trim() ? input.text.trim() : null;
    if (!name) throw ApiError.badRequest('Give the source a name.');
    if (text && text.length > KNOWLEDGE_MAX_CHARS) {
      throw ApiError.badRequest(`Source text is too large (max ${KNOWLEDGE_MAX_CHARS} characters).`);
    }
    const sourceType: KnowledgeSourceType = input.sourceType ?? 'text';
    if (!['text', 'url', 'file'].includes(sourceType)) {
      throw ApiError.badRequest('source_type must be text, url or file.');
    }
    if (sourceType === 'file') {
      throw ApiError.badRequest('Upload files through the knowledge file upload endpoint.');
    }
    if (sourceType === 'text' && !text) {
      throw ApiError.badRequest('Add text to index for a text source.');
    }
    if (sourceType === 'url' && !url) {
      throw ApiError.badRequest('Add the URL for a URL source.');
    }

    const { data, error } = await this.sb
      .from('seo_knowledge_sources')
      .insert({
        project_id: projectId,
        source_type: sourceType,
        name,
        url,
        content_text: text,
        status: 'draft',
        chunk_count: 0,
        // A new URL source starts on the manual cadence: it is only checked when
        // the user asks, never silently on a schedule (KB7).
        refresh_policy: sourceType === 'url' ? 'manual' : null,
        created_by: userId,
      })
      .select()
      .single();
    if (error || !data) throw ApiError.badRequest('Could not add the knowledge source');
    const inserted = data as SourceRow;

    // A bare URL (no captured text) has no extractor yet: it stays draft and
    // is never reported as indexed.
    if (sourceType === 'url' && !text) {
      return { source: mapSourceRow(inserted), job: null };
    }

    try {
      const job = await this.enqueueIngest(projectId, sourceRowId(inserted), userId);
      return { source: { ...mapSourceRow(inserted), status: 'queued' as const }, job };
    } catch (err) {
      // Never leave an orphan draft row when the queue refused the job.
      try {
        await this.sb.from('seo_knowledge_sources').delete().eq('project_id', projectId).eq('id', sourceRowId(inserted));
      } catch {
        // best-effort cleanup; the draft row stays visible as such
      }
      throw err;
    }
  }

  /**
   * Create a `file` source: validate the type/size/signature, upload the bytes
   * to private storage, then insert the row in `draft`. Files are NOT ingested
   * synchronously - the user starts ingestion afterwards (draft -> queued) so a
   * large PDF never blocks an HTTP request. The row is the record; storage holds
   * the bytes; extracted text is never written to Postgres.
   */
  async createFileSource(projectId: string, userId: string, input: KnowledgeFileCreateInput) {
    const reason = this.configuredReason();
    if (reason) throw ApiError.notConfigured(`Knowledge is not configured on this server. ${reason}`);
    const filename = sanitizeFilename(input.filename ?? '');
    const declaredType = (input.contentType ?? '').split(';')[0]!.trim().toLowerCase();
    const bytes = input.bytes;
    if (!bytes || bytes.length === 0) throw ApiError.badRequest('The uploaded file is empty.');
    if (bytes.length > KNOWLEDGE_MAX_FILE_BYTES) {
      throw KnowledgeService.fileApiError('knowledge_file_too_large');
    }
    const resolved = resolveFileType(filename, declaredType);
    if (!resolved.ok || !hasValidSignature(resolved.spec.format, bytes)) {
      throw KnowledgeService.fileApiError('knowledge_file_type_not_allowed');
    }
    const contentType = resolved.spec.mimes[0]!;

    const { data, error } = await this.sb
      .from('seo_knowledge_sources')
      .insert({
        project_id: projectId,
        source_type: 'file',
        name: filename,
        content_text: null,
        status: 'draft',
        chunk_count: 0,
        original_filename: filename,
        content_type: contentType,
        size_bytes: bytes.length,
        created_by: userId,
      })
      .select()
      .single();
    if (error || !data) throw ApiError.badRequest('Could not add the knowledge source');
    const inserted = data as SourceRow;
    const sourceId = sourceRowId(inserted);

    let path: string | null = null;
    try {
      path = (await this.container.knowledgeFileStore.upload({ projectId, sourceId, filename, contentType, bytes })).path;
      const committed = await this.patchRow(projectId, sourceId, ['draft'], { storage_path: path });
      if (!committed) throw ApiError.conflict('The source changed while storing the file. Try again.');
    } catch (err) {
      if (path) await this.container.knowledgeFileStore.remove(path).catch(() => undefined);
      await this.deleteRowBestEffort(projectId, sourceId);
      if (err instanceof ApiError) throw err;
      throw KnowledgeService.fileApiError('knowledge_file_storage_failed');
    }

    return { source: mapSourceRow({ ...inserted, storage_path: path }), job: null };
  }

  /** Best-effort row removal for rollback paths; never masks the original error. */
  private async deleteRowBestEffort(projectId: string, sourceId: string): Promise<void> {
    try {
      await this.sb.from('seo_knowledge_sources').delete().eq('project_id', projectId).eq('id', sourceId);
    } catch {
      // best-effort cleanup; the caller still reports the real failure
    }
  }
  /**
   * (Re)queue ingestion for an existing source: fetch/retry a `draft`/`failed`
   * URL source, reindex a `ready` one, or start a `draft` text source. The
   * lifecycle map refuses `deleted` sources and sources mid-`processing`, and a
   * second call while already `queued` is rejected so only one job runs. A URL
   * source whose fetcher is unconfigured or whose URL is invalid fails fast with
   * an honest code instead of enqueueing a job that is guaranteed to fail.
   */
  async enqueueIngest(projectId: string, sourceId: string, userId: string | null) {
    const row = await this.sourceRow(projectId, sourceId);
    const status = (row.status as KnowledgeSourceStatus) ?? 'draft';
    assertTransition(status, 'queued');
    const sourceType = (row.source_type as KnowledgeSourceType) ?? 'text';
    if (sourceType === 'file') {
      // A file row with no stored object cannot be extracted; fail fast with an
      // honest code instead of queueing a job guaranteed to fail.
      const storagePath = typeof row.storage_path === 'string' ? row.storage_path.trim() : '';
      if (!storagePath) {
        await this.patchRow(projectId, sourceId, [status], { status: 'failed', error: 'knowledge_file_missing' }).catch(
          () => undefined,
        );
        throw KnowledgeService.fileApiError('knowledge_file_missing');
      }
    } else if (!buildSourceDocument(row)) {
      const rawUrl = typeof row.url === 'string' ? row.url.trim() : '';
      if (sourceType === 'url' && rawUrl) {
        try {
          this.resolveFetchTarget(rawUrl);
        } catch (err) {
          if (isKnowledgeIngestError(err)) {
            await this.patchRow(projectId, sourceId, [status], { status: 'failed', error: err.code }).catch(() => undefined);
            throw new ApiError(err.status, err.code, err.message);
          }
          throw err;
        }
      } else {
        throw ApiError.badRequest('This source has no text to index yet.');
      }
    }
    const moved = await this.patchRow(projectId, sourceId, [status], { status: 'queued', error: null });
    if (!moved) throw ApiError.conflict('The source changed while queueing ingestion. Try again.');
    return this.container.jobStore.enqueue({
      project_id: projectId,
      provider: 'qdrant',
      job_type: 'knowledge_source_ingest',
      params: { source_id: sourceId },
      created_by: userId,
    });
  }

  /**
   * Queue an explicit refresh for a URL source (KB7). This is a thin wrapper
   * over the same job pipeline as ingest: it refuses non-URL sources, rejects a
   * source that is already queued/processing (no parallel refresh), re-validates
   * the URL through the SSRF guard before queueing, and enqueues
   * `knowledge_source_refresh`. The executor owns the actual fetch/compare.
   */
  async enqueueRefresh(projectId: string, sourceId: string, userId: string | null) {
    const row = await this.sourceRow(projectId, sourceId);
    const status = (row.status as KnowledgeSourceStatus) ?? 'draft';
    if (((row.source_type as KnowledgeSourceType) ?? 'text') !== 'url') {
      throw ApiError.conflict('Only URL sources can be refreshed.');
    }
    if (status === 'queued' || status === 'processing') {
      throw ApiError.conflict('A refresh is already in progress for this source.');
    }
    assertTransition(status, 'queued');

    // Re-validate every refresh: a URL that was acceptable last time may now
    // resolve to a private target, and the SSRF guard is the single gate before
    // any fetch. A ready source keeps its content on a bad URL; a source with no
    // content is honestly marked failed rather than queued for a doomed job.
    const rawUrl = typeof row.url === 'string' ? row.url.trim() : '';
    try {
      this.resolveFetchTarget(rawUrl);
    } catch (err) {
      if (isKnowledgeIngestError(err)) {
        if (status !== 'ready') {
          await this.patchRow(projectId, sourceId, [status], { status: 'failed', error: err.code }).catch(() => undefined);
        }
        throw new ApiError(err.status, err.code, err.message);
      }
      throw err;
    }

    const moved = await this.patchRow(projectId, sourceId, [status], { status: 'queued', error: null });
    if (!moved) throw ApiError.conflict('The source changed while queueing a refresh. Try again.');
    return this.container.jobStore.enqueue({
      project_id: projectId,
      provider: 'qdrant',
      job_type: 'knowledge_source_refresh',
      params: { source_id: sourceId },
      created_by: userId,
    });
  }

  /** Marks a source 'deleted' (terminal) and queues removal of its vectors + row. */
  async enqueueDelete(projectId: string, sourceId: string, userId: string | null) {
    const row = await this.sourceRow(projectId, sourceId);
    const status = (row.status as KnowledgeSourceStatus) ?? 'draft';
    assertTransition(status, 'deleted');
    const moved = await this.patchRow(projectId, sourceId, [status], { status: 'deleted', error: null });
    if (!moved) throw ApiError.conflict('The source changed while queueing deletion. Try again.');
    return this.container.jobStore.enqueue({
      project_id: projectId,
      provider: 'qdrant',
      job_type: 'knowledge_source_delete',
      params: { source_id: sourceId },
      created_by: userId,
    });
  }

  /**
   * Resolve the configured URL fetcher and a validated URL, or throw a
   * normalized `KnowledgeIngestError`. This is the only path that hands a URL
   * to a fetcher, so the SSRF guard always runs first and the credential is
   * read from server env only (never from the source row).
   */
  private resolveFetchTarget(rawUrl: string): { fetcher: KnowledgeFetcher; url: string } {
    const fetcher = this.container.knowledgeFetcher;
    if (!fetcher || !fetcher.isConfigured()) throw new KnowledgeIngestError('knowledge_jina_not_configured');
    return { fetcher, url: validateExternalUrl(rawUrl).toString() };
  }

  /**
   * Resolve the indexable document for a row. Text sources use the pure
   * extractor; a URL source with no captured body is fetched once through the
   * fetcher; a file source is retrieved from private storage and run through
   * its format extractor. Everything then flows through the same
   * normalize -> chunk -> index path. The fetched URL text is returned so the
   * caller can persist it on success; file text is deliberately NOT persisted
   * (storage holds the bytes), it is handled strictly as untrusted data (never
   * interpreted as instructions). Returns null when there is genuinely nothing
   * to index.
   */
  private async resolveDocument(
    row: SourceRow,
  ): Promise<{ doc: KnowledgeDocumentInput; capturedText: string | null; contentHash: string | null } | null> {
    const existing = buildSourceDocument(row);
    if (existing) return { doc: existing, capturedText: null, contentHash: null };

    const sourceType = (row.source_type as KnowledgeSourceType) ?? 'text';
    if (sourceType === 'file') return this.resolveFileDocument(row);
    const rawUrl = typeof row.url === 'string' ? row.url.trim() : '';
    if (sourceType !== 'url' || !rawUrl) return null;

    return this.fetchUrlDocument(row);
  }

  /**
   * Fetch + extract + normalize + hash one URL source, ignoring any body already
   * stored on the row. This is the only place a URL is handed to a fetcher, so
   * the SSRF guard always runs first (KB3) and the credential is read from
   * server env only. The hash is of the canonical, bounded text - the exact
   * representation the knowledge base would hold - so it is a stable change
   * detector (KB7).
   */
  private async fetchUrlDocument(
    row: SourceRow,
  ): Promise<{ doc: KnowledgeDocumentInput; capturedText: string; contentHash: string }> {
    const rawUrl = typeof row.url === 'string' ? row.url.trim() : '';
    if (!rawUrl) throw new KnowledgeIngestError('knowledge_invalid_url');
    const { fetcher, url } = this.resolveFetchTarget(rawUrl);

    let fetched: FetchedDocument;
    try {
      fetched = await fetcher.fetch(url);
    } catch (err) {
      if (isKnowledgeIngestError(err)) throw err;
      throw new KnowledgeIngestError('knowledge_fetch_provider_error');
    }

    const text = normalizeText(fetched.contentText);
    if (!text) throw new KnowledgeIngestError('knowledge_empty_content');
    if (text.length > MAX_NORMALIZED_CHARS) throw new KnowledgeIngestError('knowledge_source_too_large');
    if (chunkKnowledgeText(text).length > MAX_CHUNKS) throw new KnowledgeIngestError('knowledge_source_too_large');

    const name = typeof row.name === 'string' ? row.name.trim() : '';
    return {
      doc: {
        externalId: sourceExternalId(sourceRowId(row)),
        kind: 'note',
        title: fetched.title || name || url,
        text,
        url: fetched.canonicalUrl || url,
        collectionId: row.collection_id ? String(row.collection_id) : null,
        meta: { source: 'knowledge_source', source_type: 'url' },
      },
      capturedText: text,
      contentHash: contentHash(text),
    };
  }

  /**
   * File variant of resolveDocument (KB4): download from private storage, pick
   * the extractor for the validated format, extract plain text, then normalize
   * and bound. The extracted text is never persisted; `content_text` stays null
   * and the index is rebuildable by re-reading storage. All failures map to
   * stable `knowledge_file_*` codes - parser internal errors never escape.
   */
  private async resolveFileDocument(
    row: SourceRow,
  ): Promise<{ doc: KnowledgeDocumentInput; capturedText: null; contentHash: null } | null> {
    const storagePath = typeof row.storage_path === 'string' ? row.storage_path.trim() : '';
    if (!storagePath) throw new KnowledgeIngestError('knowledge_file_missing');

    const filename = sanitizeFilename(
      typeof row.original_filename === 'string' && row.original_filename
        ? row.original_filename
        : typeof row.name === 'string'
          ? row.name
          : 'file',
    );
    const contentType = typeof row.content_type === 'string' ? row.content_type : '';

    let bytes: Uint8Array;
    try {
      bytes = await this.container.knowledgeFileStore.download(storagePath);
    } catch {
      throw new KnowledgeIngestError('knowledge_file_missing');
    }
    if (bytes.length === 0) throw new KnowledgeIngestError('knowledge_file_no_extractable_text');
    if (bytes.length > KNOWLEDGE_MAX_FILE_BYTES) throw new KnowledgeIngestError('knowledge_file_too_large');

    const resolved = resolveFileType(filename, contentType);
    if (!resolved.ok || !hasValidSignature(resolved.spec.format, bytes)) {
      throw new KnowledgeIngestError('knowledge_file_type_not_allowed');
    }

    const file: KnowledgeFile = { filename, contentType, size: bytes.length, bytes };
    const extractor = this.container.knowledgeFileExtractors.resolve(file);
    if (!extractor) throw new KnowledgeIngestError('knowledge_file_type_not_allowed');

    let contentText: string;
    let extractedTitle: string | undefined;
    try {
      const extracted = await extractor.extract(file);
      contentText = extracted.contentText;
      extractedTitle = extracted.title;
    } catch (err) {
      if (isKnowledgeIngestError(err)) throw err;
      throw new KnowledgeIngestError('knowledge_file_extract_failed');
    }

    const text = normalizeText(contentText);
    if (!text) throw new KnowledgeIngestError('knowledge_file_no_extractable_text');
    if (text.length > KNOWLEDGE_MAX_EXTRACTED_CHARS || text.length > MAX_NORMALIZED_CHARS) {
      throw new KnowledgeIngestError('knowledge_source_too_large');
    }
    if (chunkKnowledgeText(text).length > MAX_CHUNKS) throw new KnowledgeIngestError('knowledge_source_too_large');

    const name = typeof row.name === 'string' ? row.name.trim() : '';
    return {
      doc: {
        externalId: sourceExternalId(sourceRowId(row)),
        kind: 'note',
        title: extractedTitle || name || filename,
        text,
        collectionId: row.collection_id ? String(row.collection_id) : null,
        meta: { source: 'knowledge_source', source_type: 'file', content_type: contentType },
      },
      capturedText: null,
      contentHash: null,
    };
  }

  /**
   * Background pipeline: extract/fetch -> normalize -> chunk -> embed -> index
   * one source into Qdrant, keeping the row's status honest at every step.
   *
   * Idempotent: the source's existing vectors are removed before the current
   * representation is written, so repeat runs never accumulate duplicate
   * chunks. Concurrency-safe: the row is claimed with a CAS before any fetch or
   * index work, and if a delete wins the race during indexing the just-written
   * vectors are compensated away rather than left searchable.
   */
  async ingestSource(projectId: string, sourceId: string, report?: ProgressFn): Promise<Record<string, unknown>> {
    let row: SourceRow;
    try {
      row = await this.sourceRow(projectId, sourceId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return { source_id: sourceId, skipped: true, message: 'Source no longer exists' };
      }
      throw err;
    }
    if (((row.status as KnowledgeSourceStatus) ?? 'draft') === 'deleted') {
      return { source_id: sourceId, skipped: true, message: 'Source is being deleted' };
    }

    const provider = this.knowledgeProvider();
    if (!provider) throw ApiError.notConfigured('The knowledge provider is not registered on this server.');

    // Claim the row before the (potentially slow) fetch + index steps (also
    // recovers a stale 'processing' left by a crashed worker). A 0-row CAS
    // means it was deleted or a concurrent run already owns it.
    const claimed = await this.patchRow(
      projectId,
      sourceId,
      ['queued', 'failed', 'processing'],
      { status: 'processing', error: null },
    );
    if (!claimed) {
      return { source_id: sourceId, skipped: true, message: 'Source is not ingestable right now' };
    }

    const ctx = this.context(projectId);
    try {
      const resolved = await this.resolveDocument(row);
      if (!resolved) {
        const noText = ApiError.badRequest('The knowledge source has no indexable text.');
        await this.tryPatchError(projectId, sourceId, noText);
        throw noText;
      }
      const { doc, capturedText, contentHash: hash } = resolved;

      await report?.(15, `Indexing "${doc.title}"`);
      await provider.ensureProject(ctx);
      await report?.(45, 'Embedding and chunking…');
      // Remove any previous representation first so a shorter body cannot
      // leave stale chunks behind (deterministic ids alone overwrite, not shrink).
      await provider.delete(ctx, doc.externalId);
      const { indexed } = await provider.index(ctx, [doc]);
      await report?.(80, 'Saving state');

      const now = new Date();
      const patch: Record<string, unknown> = {
        status: 'ready',
        error: null,
        chunk_count: indexed,
        last_indexed_at: now.toISOString(),
      };
      // Persist the fetched snapshot only on success, so a failed index never
      // leaves a half-captured body behind. A URL fetch also records its
      // freshness facts here: this is the first successful capture of the body.
      if (capturedText !== null) patch.content_text = capturedText;
      if (hash) {
        patch.content_hash = hash;
        patch.last_fetched_at = now.toISOString();
        patch.last_changed_at = now.toISOString();
        patch.next_refresh_at = nextRefreshAt(normalizeRefreshPolicy(row.refresh_policy), now);
        patch.refresh_failures = 0;
      }
      const committed = await this.patchRow(projectId, sourceId, ['processing'], patch);
      if (!committed) {
        // A delete won the race while we were indexing: drop what we wrote.
        await provider.delete(ctx, doc.externalId).catch(() => undefined);
        return { source_id: sourceId, skipped: true, message: 'Source was removed during indexing' };
      }
      await report?.(100, `Indexed ${indexed} chunk(s)`);
      return { source_id: sourceId, chunks: indexed };
    } catch (err) {
      await this.tryPatchError(projectId, sourceId, err, 'knowledge_index_failed');
      throw KnowledgeService.mapError(err);
    }
  }

  /**
   * Refresh one URL source (KB7): always re-fetch, then decide from a SHA-256
   * content hash whether anything actually changed.
   *
   *   unchanged -> update only the freshness facts; vectors, body and
   *                last_changed_at are left untouched (no Jina/embedding/index
   *                cost is paid again)
   *   changed   -> run the normal index pipeline and commit the new body
   *   failure   -> if the source already had searchable content, keep it and
   *                the existing vectors, record the failure with a bounded
   *                retry time and leave the source `ready`; only a source with
   *                no usable content is allowed to become `failed`.
   *
   * Claiming uses the same CAS as ingest, so a delete that wins the race can
   * never be resurrected and two refreshes can never run in parallel.
   */
  async refreshSource(projectId: string, sourceId: string, report?: ProgressFn): Promise<Record<string, unknown>> {
    let row: SourceRow;
    try {
      row = await this.sourceRow(projectId, sourceId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return { source_id: sourceId, skipped: true, message: 'Source no longer exists' };
      }
      throw err;
    }
    if (((row.status as KnowledgeSourceStatus) ?? 'draft') === 'deleted') {
      return { source_id: sourceId, skipped: true, message: 'Source is being deleted' };
    }
    if (((row.source_type as KnowledgeSourceType) ?? 'text') !== 'url') {
      throw ApiError.conflict('Only URL sources can be refreshed.');
    }

    const provider = this.knowledgeProvider();
    if (!provider) throw ApiError.notConfigured('The knowledge provider is not registered on this server.');

    const claimed = await this.patchRow(projectId, sourceId, ['queued', 'processing', 'failed', 'ready'], {
      status: 'processing',
      error: null,
    });
    if (!claimed) {
      return { source_id: sourceId, skipped: true, message: 'Source is already refreshing' };
    }

    const ctx = this.context(projectId);
    const hasExistingContent = typeof row.content_text === 'string' && row.content_text.trim().length > 0;
    const existingHash = typeof row.content_hash === 'string' ? row.content_hash : '';
    const policy = normalizeRefreshPolicy(row.refresh_policy);

    try {
      await report?.(10, 'Fetching the latest page');
      await provider.ensureProject(ctx);
      const { doc, capturedText, contentHash: newHash } = await this.fetchUrlDocument(row);
      const now = new Date();

      if (hasExistingContent && existingHash && newHash === existingHash) {
        const committed = await this.patchRow(projectId, sourceId, ['processing'], {
          status: 'ready',
          error: null,
          last_fetched_at: now.toISOString(),
          next_refresh_at: nextRefreshAt(policy, now),
          refresh_failures: 0,
        });
        if (!committed) {
          return { source_id: sourceId, skipped: true, message: 'Source was removed during refresh' };
        }
        await report?.(100, 'Checked - no content changes');
        return { source_id: sourceId, refreshed: true, changed: false, chunks: Number(row.chunk_count ?? 0) };
      }

      await report?.(45, 'Content changed - reindexing');
      await provider.delete(ctx, doc.externalId);
      const { indexed } = await provider.index(ctx, [doc]);
      const committed = await this.patchRow(projectId, sourceId, ['processing'], {
        status: 'ready',
        error: null,
        chunk_count: indexed,
        last_indexed_at: now.toISOString(),
        last_fetched_at: now.toISOString(),
        last_changed_at: now.toISOString(),
        content_text: capturedText,
        content_hash: newHash,
        next_refresh_at: nextRefreshAt(policy, now),
        refresh_failures: 0,
      });
      if (!committed) {
        // A delete won the race while we were indexing: drop what we wrote.
        await provider.delete(ctx, doc.externalId).catch(() => undefined);
        return { source_id: sourceId, skipped: true, message: 'Source was removed during refresh' };
      }
      await report?.(100, `Updated and reindexed ${indexed} chunk(s)`);
      return { source_id: sourceId, refreshed: true, changed: true, chunks: indexed };
    } catch (err) {
      if (hasExistingContent) {
        const code = KnowledgeService.safeError(err, 'knowledge_fetch_provider_error');
        const failures = Number(row.refresh_failures ?? 0) + 1;
        const retryAt = new Date(Date.now() + refreshBackoffMs(failures)).toISOString();
        await this.patchRow(projectId, sourceId, ['processing'], {
          status: 'ready',
          error: code,
          refresh_failures: failures,
          next_refresh_at: retryAt,
        }).catch(() => undefined);
        await report?.(100, 'Refresh failed - existing content is still available');
        // A refresh failure on existing content is a handled outcome, not a
        // failed job: the source keeps its vectors and the retry is bounded by
        // refresh_failures/next_refresh_at rather than by the job backoff.
        return { source_id: sourceId, refreshed: false, failed: true, error: code };
      }
      await this.tryPatchError(projectId, sourceId, err, 'knowledge_index_failed');
      throw KnowledgeService.mapError(err);
    }
  }

  /**
   * Reflect a project-wide vector wipe on the source read-model. Called by the
   * `knowledge_delete` executor after `provider.deleteProject`: sources with
   * captured text or a stored file return to `queued` (re-ingestable); only
   * bare URL sources with no captured body return to `draft`. Kept here so
   * status writes never live in the executor.
   */
  async resetStatusesAfterProjectWipe(projectId: string): Promise<void> {
    const { error: resetError } = await this.sb
      .from('seo_knowledge_sources')
      .update({ status: 'queued', chunk_count: 0, error: null })
      .eq('project_id', projectId)
      .or('content_text.not.is.null,storage_path.not.is.null');
    if (resetError) {
      throw new ApiError(502, 'knowledge_provider_error', 'Knowledge cleared but source flags could not be reset');
    }
    const { error: draftError } = await this.sb
      .from('seo_knowledge_sources')
      .update({ status: 'draft', chunk_count: 0, error: null })
      .eq('project_id', projectId)
      .or('content_text.is.null,content_text.eq.')
      .is('storage_path', null);
    if (draftError) {
      throw new ApiError(502, 'knowledge_provider_error', 'Knowledge cleared but URL source flags could not be reset');
    }
  }

  /** Background pipeline: drop the source's vectors, remove its stored file (if
   *  any), then its traceability row. Idempotent - an already-removed row is
   *  reported, not treated as an error. Storage cleanup failure keeps the row in
   *  its terminal `deleted` state and surfaces so the job retries: it never
   *  resurrects the source or reports a silent leak. */
  async deleteSource(projectId: string, sourceId: string): Promise<Record<string, unknown>> {
    const provider = this.knowledgeProvider();
    if (!provider) throw ApiError.notConfigured('The knowledge provider is not registered on this server.');
    const { data } = await this.sb
      .from('seo_knowledge_sources')
      .select('status, storage_path')
      .eq('project_id', projectId)
      .eq('id', sourceId)
      .maybeSingle();
    if (!data) return { source_id: sourceId, deleted: false, message: 'Already removed' };
    const status = ((data as { status?: string }).status as KnowledgeSourceStatus) ?? 'deleted';
    try {
      await provider.delete(this.context(projectId), sourceExternalId(sourceId));
    } catch (err) {
      // The row is already terminal ('deleted'); record the failure without
      // resurrecting it. The job itself carries the retry/error state.
      await this.patchRow(projectId, sourceId, [status], { error: KnowledgeService.safeError(err) }).catch(() => undefined);
      throw KnowledgeService.mapError(err);
    }
    const storagePath = typeof (data as { storage_path?: unknown }).storage_path === 'string'
      ? ((data as { storage_path: string }).storage_path).trim()
      : '';
    if (storagePath) {
      try {
        await this.container.knowledgeFileStore.remove(storagePath);
      } catch (err) {
        const wrapped = isKnowledgeIngestError(err) ? err : new KnowledgeIngestError('knowledge_file_storage_failed');
        await this.patchRow(projectId, sourceId, [status], { error: wrapped.code }).catch(() => undefined);
        throw KnowledgeService.mapError(wrapped);
      }
    }
    const { error } = await this.sb.from('seo_knowledge_sources').delete().eq('project_id', projectId).eq('id', sourceId);
    if (error) throw ApiError.badRequest('Could not remove the knowledge source row');
    return { source_id: sourceId, deleted: true };
  }
}

/** Narrow helper: the id of an inserted row (kept separate for readability). */
function sourceRowId(row: SourceRow): string {
  return String(row.id);
}
