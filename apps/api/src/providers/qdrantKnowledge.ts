/**
 * Qdrant-backed KnowledgeProvider.
 *
 * Every stored point carries { project_id, external_id, kind, ... } and every
 * search/delete filters on project_id, making cross-project retrieval
 * impossible. Text is chunked here (embedding-safe sizes); chunking strategy is
 * an implementation detail of the provider.
 *
 * The collection is a single shared 'seo_knowledge' vector space (Qdrant
 * collections are not free to create per project), so isolation is entirely
 * payload-filter based: project_id appears in the `must` of every search and
 * delete. Point ids are deterministic digests of (projectId, externalId,
 * chunk), which makes indexing idempotent - re-running an index overwrites the
 * same chunks instead of growing duplicates.
 */

import { createHash } from 'node:crypto';
import type {
  KnowledgeDocumentInput,
  KnowledgeProvider,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  ProviderContext,
  ProviderDeps,
} from '@seo/contracts';
import { QdrantClient, matchOn } from './knowledge/qdrantClient.js';
import { embedderFromConfig, type Embedder } from './knowledge/embedding.js';
import { chunkKnowledgeText } from '../knowledge/chunker.js';

/** Shared vector collection name (project separation is by payload, not name). */
const COLLECTION = 'seo_knowledge';

/**
 * Stable UUID for one chunk of one external document. sha256 over the triple
 * is truncated to 32 hex chars and formatted as a UUID v4-looking string -
 * stable across re-indexes (idempotent upsert) and practically collision-free.
 */
export function deterministicId(projectId: string, externalId: string, chunk: number): string {
  const digest = createHash('sha256')
    .update(`${projectId}:${externalId}:${chunk}`)
    .digest();
  const hex = digest.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The platform's only KnowledgeProvider. Constructed with the global server
 * config; if either Qdrant or an embedding key is missing it keeps null
 * handles and reports itself via assertConfigured errors instead of pretending
 * to work.
 */
export class QdrantKnowledgeProvider implements KnowledgeProvider {
  readonly id = 'qdrant';
  readonly name = 'Qdrant';
  readonly capabilities = ['index', 'search', 'update', 'delete'] as const;
  private readonly client: QdrantClient | null;
  private readonly embedder: Embedder | null;

  constructor(deps: ProviderDeps) {
    const url = deps.config.QDRANT_URL;
    const apiKey = deps.config.QDRANT_API_KEY;
    this.client = url && apiKey ? new QdrantClient(url, apiKey) : null;
    this.embedder = embedderFromConfig(deps.config);
  }

  /** Both dependencies are required; which one is missing is called out clearly. */
  private assertConfigured() {
    if (!this.client) {
      throw new Error('Qdrant is not configured: set QDRANT_URL and QDRANT_API_KEY');
    }
    if (!this.embedder) {
      throw new Error(
        'No embedding provider configured: set EMBEDDINGS_API_KEY or OPENAI_API_KEY',
      );
    }
  }

  /**
   * No-op per project (single shared collection), kept to satisfy the
   * interface contract: it only guarantees the collection + indexes exist the
   * first time any project indexes.
   */
  async ensureProject(_ctx: ProviderContext): Promise<void> {
    this.assertConfigured();
    await this.client!.ensureCollection(COLLECTION, this.embedder!.dimensions);
  }

  /**
   * Embed + store documents as chunked points. Chunks are embedded in one call
   * per document; each point records source metadata and its chunk index so a
   * later search hit can point back at the exact slice of the source text.
   */
  async index(ctx: ProviderContext, documents: KnowledgeDocumentInput[]): Promise<{ indexed: number }> {
    this.assertConfigured();
    const points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> = [];
    for (const doc of documents) {
      const chunks = chunkKnowledgeText(doc.text);
      if (chunks.length === 0) continue;
      const embeddings = await this.embedder!.embed(chunks);
      const indexedAt = new Date().toISOString();
      chunks.forEach((text, i) => {
        points.push({
          id: deterministicId(ctx.projectId, doc.externalId, i),
          vector: embeddings[i] ?? [],
          payload: {
            project_id: ctx.projectId,
            external_id: doc.externalId,
            source_type: doc.kind,
            source_id: doc.externalId,
            kind: doc.kind,
            title: doc.title ?? null,
            url: doc.url ?? null,
            text,
            chunk_index: i,
            chunk_total: chunks.length,
            indexed_at: indexedAt,
            meta: doc.meta ?? {},
          },
        });
      });
    }
    if (points.length > 0) {
      await this.client!.upsertPoints(COLLECTION, points);
    }
    return { indexed: points.length };
  }

  /**
   * Full-project replace: delete every point for the project, then index the
   * given documents. deleted:-1 is intentional - Qdrant reports no count for
   * filter deletes, so -1 signals "cleared, unknown how many" rather than a
   * fabricated zero.
   */
  async reindex(ctx: ProviderContext, documents: KnowledgeDocumentInput[]): Promise<{ indexed: number; deleted: number }> {
    this.assertConfigured();
    await this.client!.deleteByFilter(COLLECTION, {
      must: [matchOn('project_id', ctx.projectId)],
    });
    const { indexed } = await this.index(ctx, documents);
    return { indexed, deleted: -1 };
  }

  /**
   * Delete one external document's chunks. The filter scopes on project_id AND
   * external_id, so a source removed from one project can never reach into
   * another project's copy of the same external id.
   */
  async delete(ctx: ProviderContext, externalId: string): Promise<void> {
    this.assertConfigured();
    await this.client!.deleteByFilter(COLLECTION, {
      must: [matchOn('project_id', ctx.projectId), matchOn('external_id', externalId)],
    });
  }

  /** Delete every point a project owns (project teardown / full reindex). */
  async deleteProject(ctx: ProviderContext): Promise<void> {
    this.assertConfigured();
    await this.client!.deleteByFilter(COLLECTION, {
      must: [matchOn('project_id', ctx.projectId)],
    });
  }

  /**
   * Semantic search. The query is embedded with the same embedder used for
   * indexing (model drift between index and query would silently break
   * results), the candidate set is narrowed to the project's points, and an
   * optional kind filter narrows further before cosine ranking.
   */
  async search(opts: KnowledgeSearchOptions): Promise<KnowledgeSearchResult[]> {
    this.assertConfigured();
    const vectors = await this.embedder!.embed([opts.query]);
    const filter: { must: Array<Record<string, unknown>> } = {
      must: [matchOn('project_id', opts.projectId)],
    };
    if (opts.filter?.kind) {
      const kinds = Array.isArray(opts.filter.kind) ? opts.filter.kind : [opts.filter.kind];
      filter.must.push({ key: 'kind', match: { any: kinds } });
    }
    const hits = await this.client!.search(COLLECTION, vectors[0] ?? [], filter, opts.limit ?? 8);
    return hits.map((h: { id: string; score: number; payload: Record<string, unknown> }) => ({ id: h.id, score: h.score, payload: h.payload }));
  }
}
