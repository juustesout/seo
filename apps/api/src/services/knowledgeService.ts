/**
 * Knowledge source service (SEO Core).
 *
 * Project-scoped user-managed knowledge items for Content Studio. Each source
 * row is the logical model of an indexed item; its vectors live in the shared
 * Qdrant collection under external_id `source:<id>` so every vector is
 * traceable back to this table. This service is the single owner of the
 * ingest/delete pipeline for these sources - it is called by the HTTP routes
 * (add/remove/list/retry) AND by the worker executors (background ingest and
 * deletion). It reuses the registered QdrantKnowledgeProvider and its
 * embedding/chunking unchanged - there is deliberately no second vector/RAG
 * implementation here.
 *
 * Project isolation is enforced at every layer: the row is read/written under
 * a project_id filter, and the Qdrant provider filters every search/delete on
 * project_id too.
 */

import type {
  KnowledgeDocumentInput,
  KnowledgeProvider,
  KnowledgeSourceDto,
  KnowledgeSourceType,
  ProviderContext,
} from '@seo/contracts';
import { logger } from '../logger.js';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';

/** Largest single source body we accept for indexing. */
export const KNOWLEDGE_MAX_CHARS = 100_000;

export type SourceRow = Record<string, unknown>;

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
 * Builds the provider document for one source row. Text is the user content
 * (normalization + chunking are the provider's deterministic job); URL-only
 * sources still get a small, addressable stub so they are findable.
 * Returns null when the row carries nothing indexable.
 */
export function buildSourceDocument(row: SourceRow): KnowledgeDocumentInput | null {
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  const url = typeof row.url === 'string' && row.url.trim() ? row.url.trim() : null;
  const content = typeof row.content_text === 'string' ? row.content_text.replace(/\s+/g, ' ').trim() : '';
  const id = typeof row.id === 'string' ? row.id : '';
  const type = (row.source_type as KnowledgeSourceType | null) ?? 'note';
  if (!name && !content) return null;
  const text = content || `${name}\n${url ? `Reference URL: ${url}` : ''}`.trim();
  if (!text) return null;
  return {
    externalId: sourceExternalId(id),
    kind: 'note',
    title: name || url || 'Knowledge source',
    text,
    url: url ?? undefined,
    meta: { source: 'knowledge_source', source_type: type },
  };
}

export function mapSourceRow(row: SourceRow): KnowledgeSourceDto {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    source_type: (row.source_type as KnowledgeSourceType) ?? 'note',
    name: String(row.name ?? ''),
    url: row.url ? String(row.url) : null,
    status: (row.status as KnowledgeSourceDto['status']) ?? 'pending',
    error: row.error ? String(row.error) : null,
    chunk_count: Number(row.chunk_count ?? 0),
    last_indexed_at: row.last_indexed_at ? String(row.last_indexed_at) : null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
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

  private async setRow(projectId: string, sourceId: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.sb
      .from('seo_knowledge_sources')
      .update(patch)
      .eq('project_id', projectId)
      .eq('id', sourceId);
    if (error) throw ApiError.badRequest('Could not update the knowledge source');
  }

  private async setRowError(projectId: string, sourceId: string, err: unknown): Promise<void> {
    await this.setRow(projectId, sourceId, { status: 'error', error: KnowledgeService.safeError(err) });
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
   * Validates input, inserts a pending source row and queues its ingest job.
   * The vectors are written by the worker, not here.
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
    if (!text && !url) throw ApiError.badRequest('Add text or a URL so there is something to index.');
    if (text && text.length > KNOWLEDGE_MAX_CHARS) {
      throw ApiError.badRequest(`Source text is too large (max ${KNOWLEDGE_MAX_CHARS} characters).`);
    }
    const sourceType: KnowledgeSourceType = input.sourceType ?? 'note';
    if (!['note', 'reference', 'url'].includes(sourceType)) {
      throw ApiError.badRequest('source_type must be note, reference or url.');
    }

    const { data, error } = await this.sb
      .from('seo_knowledge_sources')
      .insert({
        project_id: projectId,
        source_type: sourceType,
        name,
        url,
        content_text: text,
        status: 'pending',
        chunk_count: 0,
        created_by: userId,
      })
      .select()
      .single();
    if (error || !data) throw ApiError.badRequest('Could not add the knowledge source');
    const source = mapSourceRow(data as SourceRow);
    try {
      const job = await this.enqueueIngest(projectId, source.id, userId);
      return { source, job };
    } catch (err) {
      // Never leave an orphan "pending" row when the queue refused the job.
      try {
        await this.sb.from('seo_knowledge_sources').delete().eq('project_id', projectId).eq('id', source.id);
      } catch {
        // best-effort cleanup; the row stays pending and is visible as such
      }
      throw err;
    }
  }

  /** (Re)queue ingestion for an existing source (used to retry failed ones). */
  async enqueueIngest(projectId: string, sourceId: string, userId: string | null) {
    const row = await this.sourceRow(projectId, sourceId);
    if (row.status === 'deleting') throw ApiError.conflict('This source is being deleted.');
    return this.container.jobStore.enqueue({
      project_id: projectId,
      provider: 'qdrant',
      job_type: 'knowledge_source_ingest',
      params: { source_id: sourceId },
      created_by: userId,
    });
  }

  /** Marks a source 'deleting' and queues removal of its vectors + row. */
  async enqueueDelete(projectId: string, sourceId: string, userId: string | null) {
    const row = await this.sourceRow(projectId, sourceId);
    if (row.status === 'deleting') throw ApiError.conflict('Deletion is already in progress for this source.');
    await this.setRow(projectId, sourceId, { status: 'deleting', error: null });
    return this.container.jobStore.enqueue({
      project_id: projectId,
      provider: 'qdrant',
      job_type: 'knowledge_source_delete',
      params: { source_id: sourceId },
      created_by: userId,
    });
  }

  /**
   * Background pipeline: embed + chunk + index one source into Qdrant and keep
   * the row's status honest. Runs inside the worker executor.
   */
  async ingestSource(projectId: string, sourceId: string, report?: ProgressFn): Promise<Record<string, unknown>> {
    const row = await this.sourceRow(projectId, sourceId);
    if (row.status === 'deleting') {
      return { source_id: sourceId, skipped: true, message: 'Source is being deleted' };
    }
    const provider = this.knowledgeProvider();
    if (!provider) throw ApiError.notConfigured('The knowledge provider is not registered on this server.');

    const doc = buildSourceDocument(row);
    if (!doc) {
      await this.setRowError(projectId, sourceId, new Error('The source has no indexable text.'));
      throw ApiError.badRequest('The knowledge source has no indexable text.');
    }

    await this.setRow(projectId, sourceId, { status: 'indexing', error: null });
    try {
      const ctx = this.context(projectId);
      await report?.(15, `Indexing "${doc.title}"`);
      await provider.ensureProject(ctx);
      await report?.(45, 'Embedding and chunking…');
      const { indexed } = await provider.index(ctx, [doc]);
      await report?.(80, 'Saving state');
      await this.setRow(projectId, sourceId, {
        status: 'indexed',
        error: null,
        chunk_count: indexed,
        last_indexed_at: new Date().toISOString(),
      });
      await report?.(100, `Indexed ${indexed} chunk(s)`);
      return { source_id: sourceId, chunks: indexed };
    } catch (err) {
      await this.setRowError(projectId, sourceId, err).catch(() => null);
      throw KnowledgeService.mapError(err);
    }
  }

  /** Background pipeline: drop the source's vectors then its traceability row. */
  async deleteSource(projectId: string, sourceId: string): Promise<Record<string, unknown>> {
    const provider = this.knowledgeProvider();
    if (!provider) throw ApiError.notConfigured('The knowledge provider is not registered on this server.');
    const exists = await this.sb
      .from('seo_knowledge_sources')
      .select('id')
      .eq('project_id', projectId)
      .eq('id', sourceId)
      .maybeSingle()
      .then((r) => Boolean(r.data));
    if (!exists) return { source_id: sourceId, deleted: false, message: 'Already removed' };
    try {
      await provider.delete(this.context(projectId), sourceExternalId(sourceId));
    } catch (err) {
      await this.setRowError(projectId, sourceId, err).catch(() => null);
      throw KnowledgeService.mapError(err);
    }
    const { error } = await this.sb.from('seo_knowledge_sources').delete().eq('project_id', projectId).eq('id', sourceId);
    if (error) throw ApiError.badRequest('Could not remove the knowledge source row');
    return { source_id: sourceId, deleted: true };
  }
}
