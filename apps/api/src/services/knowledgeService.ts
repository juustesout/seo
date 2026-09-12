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
  KnowledgeDocumentInput,
  KnowledgeFetcher,
  KnowledgeFile,
  KnowledgeProvider,
  KnowledgeSourceDetailDto,
  KnowledgeSourceDto,
  KnowledgeSourceListQuery,
  KnowledgeSourcePreviewDto,
  KnowledgeSourceStatus,
  KnowledgeSourceSummaryDto,
  KnowledgeSourceType,
  ProviderContext,
} from '@seo/contracts';
import { KNOWLEDGE_ERROR_MESSAGES } from '@seo/contracts';
import { logger } from '../logger.js';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { assertTransition } from './knowledgeLifecycle.js';
import { extractSourceText, normalizeText } from './knowledgeText.js';
import { chunkKnowledgeText } from '../knowledge/chunker.js';
import {
  KNOWLEDGE_LIST_DEFAULT_LIMIT,
  KNOWLEDGE_LIST_MAX_LIMIT,
  KNOWLEDGE_MAX_EXTRACTED_CHARS,
  KNOWLEDGE_MAX_FILE_BYTES,
  KNOWLEDGE_PREVIEW_MAX_CHARS,
  KNOWLEDGE_SEARCH_MAX_CHARS,
  MAX_CHUNKS,
  MAX_NORMALIZED_CHARS,
} from '../knowledge/limits.js';
import { KnowledgeIngestError, isKnowledgeIngestError, type KnowledgeIngestErrorCode } from '../knowledge/errors.js';
import { validateExternalUrl } from '../knowledge/url.js';
import { hasValidSignature, resolveFileType, sanitizeFilename } from '../knowledge/files/fileTypes.js';

/** Largest single source body accepted for indexing (bytes/chars). Bounding it
 *  keeps chunking latency and Qdrant payloads sane for a UI/managed item. */
export const KNOWLEDGE_MAX_CHARS = 100_000;

/** Columns safe to expose in a list/detail DTO. Deliberately excludes
 *  `content_text` (large, private body) and `storage_path` (private object
 *  key) so neither can leak through a list response. */
const SOURCE_LIST_COLUMNS =
  'id, project_id, source_type, name, url, status, error, chunk_count, last_indexed_at, original_filename, content_type, size_bytes, created_at, updated_at';

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
    meta: { source: 'knowledge_source', source_type: type },
  };
}

/** Safe row -> DTO mapping: exposes status/error for honest reporting but
 *  never the raw body content, so source text is only reachable through the
 *  provider, never through this API. */
export function mapSourceRow(row: SourceRow): KnowledgeSourceDto {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    source_type: (row.source_type as KnowledgeSourceType) ?? 'text',
    name: String(row.name ?? ''),
    url: row.url ? String(row.url) : null,
    status: (row.status as KnowledgeSourceDto['status']) ?? 'queued',
    error: row.error ? String(row.error) : null,
    chunk_count: Number(row.chunk_count ?? 0),
    last_indexed_at: row.last_indexed_at ? String(row.last_indexed_at) : null,
    original_filename: row.original_filename ? String(row.original_filename) : null,
    content_type: row.content_type ? String(row.content_type) : null,
    size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
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
      .select('*')
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
    const term = sanitizeKnowledgeSearch(query.search);
    if (term) {
      q = q.or(`name.ilike.%${term}%,url.ilike.%${term}%,original_filename.ilike.%${term}%`);
    }
    const { data, error, count } = await q
      .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw ApiError.badRequest('Could not list knowledge sources');
    const items = ((data ?? []) as SourceRow[]).map(mapSourceRow);
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
  ): Promise<{ doc: KnowledgeDocumentInput; capturedText: string | null } | null> {
    const existing = buildSourceDocument(row);
    if (existing) return { doc: existing, capturedText: null };

    const sourceType = (row.source_type as KnowledgeSourceType) ?? 'text';
    if (sourceType === 'file') return this.resolveFileDocument(row);
    const rawUrl = typeof row.url === 'string' ? row.url.trim() : '';
    if (sourceType !== 'url' || !rawUrl) return null;

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
        meta: { source: 'knowledge_source', source_type: 'url' },
      },
      capturedText: text,
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
  ): Promise<{ doc: KnowledgeDocumentInput; capturedText: null } | null> {
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
        meta: { source: 'knowledge_source', source_type: 'file', content_type: contentType },
      },
      capturedText: null,
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
      const { doc, capturedText } = resolved;

      await report?.(15, `Indexing "${doc.title}"`);
      await provider.ensureProject(ctx);
      await report?.(45, 'Embedding and chunking…');
      // Remove any previous representation first so a shorter body cannot
      // leave stale chunks behind (deterministic ids alone overwrite, not shrink).
      await provider.delete(ctx, doc.externalId);
      const { indexed } = await provider.index(ctx, [doc]);
      await report?.(80, 'Saving state');

      const patch: Record<string, unknown> = {
        status: 'ready',
        error: null,
        chunk_count: indexed,
        last_indexed_at: new Date().toISOString(),
      };
      // Persist the fetched snapshot only on success, so a failed index never
      // leaves a half-captured body behind.
      if (capturedText !== null) patch.content_text = capturedText;
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
