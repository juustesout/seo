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
 * One canonical pipeline (KB2):
 *
 *   source row -> extract (knowledgeText) -> normalize        [here]
 *              -> chunk (provider chunker) -> embed -> index  [provider]
 *
 * `text` is fully supported; `url`/`file` extractors honestly report "not
 * available" until KB3/KB4 add them, so those later capabilities feed the same
 * pipeline rather than a parallel one. Postgres stays the source of truth: the
 * original `content_text` is never rewritten, normalization is processing
 * output only, and Qdrant is always rebuildable from the row.
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
  KnowledgeDocumentInput,
  KnowledgeProvider,
  KnowledgeSourceDto,
  KnowledgeSourceStatus,
  KnowledgeSourceType,
  ProviderContext,
} from '@seo/contracts';
import { logger } from '../logger.js';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { assertTransition } from './knowledgeLifecycle.js';
import { extractSourceText } from './knowledgeText.js';

/** Largest single source body accepted for indexing (bytes/chars). Bounding it
 *  keeps chunking latency and Qdrant payloads sane for a UI/managed item. */
export const KNOWLEDGE_MAX_CHARS = 100_000;

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

  /** Best-effort non-fatal error write; never throws. */
  private async tryPatchError(projectId: string, sourceId: string, err: unknown): Promise<void> {
    await this.patchRow(
      projectId,
      sourceId,
      ['queued', 'processing', 'ready', 'failed'],
      { status: 'failed', error: KnowledgeService.safeError(err) },
    ).catch(() => undefined);
  }

  /** Secret-free, bounded error text for the row's `error` column. */
  private static safeError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return message.slice(0, 400);
  }

  /** Maps provider failures to clean ApiErrors; details never reach the client. */
  private static mapError(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    const message = err instanceof Error ? err.message : String(err);
    if (/not configured/i.test(message)) {
      return ApiError.notConfigured(
        'Knowledge is not configured on this server. Add QDRANT_URL/QDRANT_API_KEY and an embedding key to the API environment.',
      );
    }
    logger.error({ err }, 'knowledge source operation failed');
    return new ApiError(502, 'knowledge_provider_error', 'The knowledge provider failed. Please try again later.');
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

  /** List this project's knowledge sources, newest update first. */
  async listSources(projectId: string): Promise<KnowledgeSourceDto[]> {
    const { data, error } = await this.sb
      .from('seo_knowledge_sources')
      .select('id, project_id, source_type, name, url, status, error, chunk_count, last_indexed_at, created_at, updated_at')
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .limit(200);
    if (error) throw ApiError.badRequest('Could not list knowledge sources');
    return ((data ?? []) as SourceRow[]).map(mapSourceRow);
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
      throw new ApiError(
        400,
        'knowledge_file_ingestion_not_available',
        'File ingestion is not available yet. Paste the text instead.',
      );
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
   * (Re)queue ingestion for an existing source: retry a `failed` one, reindex
   * a `ready` one, or start a `draft` one. The lifecycle map refuses `deleted`
   * sources and sources mid-`processing`; `text`less sources are refused so an
   * unfetched URL can never be faked into `ready`.
   */
  async enqueueIngest(projectId: string, sourceId: string, userId: string | null) {
    const row = await this.sourceRow(projectId, sourceId);
    const status = (row.status as KnowledgeSourceStatus) ?? 'draft';
    assertTransition(status, 'queued');
    if (!buildSourceDocument(row)) {
      throw ApiError.badRequest('This source has no text to index yet. URL fetching is not available yet.');
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
   * Background pipeline: extract -> normalize -> chunk -> embed -> index one
   * source into Qdrant, keeping the row's status honest at every step.
   *
   * Idempotent: the source's existing vectors are removed before the current
   * representation is written, so repeat runs never accumulate duplicate
   * chunks. Concurrency-safe: the row is claimed with a CAS, and if a delete
   * wins the race during indexing the just-written vectors are compensated
   * away rather than left searchable.
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

    const doc = buildSourceDocument(row);
    if (!doc) {
      await this.tryPatchError(projectId, sourceId, new Error('The source has no indexable text.'));
      throw ApiError.badRequest('The knowledge source has no indexable text.');
    }

    // Claim the row for processing (also recovers a stale 'processing' left by
    // a crashed worker). A 0-row CAS means it was deleted or is not ours.
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
      await report?.(15, `Indexing "${doc.title}"`);
      await provider.ensureProject(ctx);
      await report?.(45, 'Embedding and chunking…');
      // Remove any previous representation first so a shorter body cannot
      // leave stale chunks behind (deterministic ids alone overwrite, not shrink).
      await provider.delete(ctx, doc.externalId);
      const { indexed } = await provider.index(ctx, [doc]);
      await report?.(80, 'Saving state');

      const committed = await this.patchRow(projectId, sourceId, ['processing'], {
        status: 'ready',
        error: null,
        chunk_count: indexed,
        last_indexed_at: new Date().toISOString(),
      });
      if (!committed) {
        // A delete won the race while we were indexing: drop what we wrote.
        await provider.delete(ctx, doc.externalId).catch(() => undefined);
        return { source_id: sourceId, skipped: true, message: 'Source was removed during indexing' };
      }
      await report?.(100, `Indexed ${indexed} chunk(s)`);
      return { source_id: sourceId, chunks: indexed };
    } catch (err) {
      await this.tryPatchError(projectId, sourceId, err);
      throw KnowledgeService.mapError(err);
    }
  }

  /**
   * Reflect a project-wide vector wipe on the source read-model. Called by the
   * `knowledge_delete` executor after `provider.deleteProject`: sources with
   * captured text return to `queued` (re-ingestable), bare URL/file sources
   * with no extractor return to `draft`. Kept here so status writes never live
   * in the executor.
   */
  async resetStatusesAfterProjectWipe(projectId: string): Promise<void> {
    const { error: resetError } = await this.sb
      .from('seo_knowledge_sources')
      .update({ status: 'queued', chunk_count: 0, error: null })
      .eq('project_id', projectId)
      .not('content_text', 'is', null)
      .neq('content_text', '');
    if (resetError) {
      throw new ApiError(502, 'knowledge_provider_error', 'Knowledge cleared but source flags could not be reset');
    }
    const { error: draftError } = await this.sb
      .from('seo_knowledge_sources')
      .update({ status: 'draft', chunk_count: 0, error: null })
      .eq('project_id', projectId)
      .or('content_text.is.null,content_text.eq.');
    if (draftError) {
      throw new ApiError(502, 'knowledge_provider_error', 'Knowledge cleared but URL source flags could not be reset');
    }
  }

  /** Background pipeline: drop the source's vectors then its traceability row.
   *  Idempotent - an already-removed row is reported, not treated as an error. */
  async deleteSource(projectId: string, sourceId: string): Promise<Record<string, unknown>> {
    const provider = this.knowledgeProvider();
    if (!provider) throw ApiError.notConfigured('The knowledge provider is not registered on this server.');
    const { data } = await this.sb
      .from('seo_knowledge_sources')
      .select('status')
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
    const { error } = await this.sb.from('seo_knowledge_sources').delete().eq('project_id', projectId).eq('id', sourceId);
    if (error) throw ApiError.badRequest('Could not remove the knowledge source row');
    return { source_id: sourceId, deleted: true };
  }
}

/** Narrow helper: the id of an inserted row (kept separate for readability). */
function sourceRowId(row: SourceRow): string {
  return String(row.id);
}
