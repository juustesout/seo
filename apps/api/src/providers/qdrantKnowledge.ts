/**
 * Qdrant-backed KnowledgeProvider.
 *
 * Every stored point carries { project_id, external_id, kind, ... } and every
 * search/delete filters on project_id, making cross-project retrieval
 * impossible. Text is chunked here (embedding-safe sizes); chunking strategy is
 * an implementation detail of the provider.
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

const COLLECTION = 'seo_knowledge';
const CHUNK_TARGET = 900;
const CHUNK_OVERLAP = 100;

export function deterministicId(projectId: string, externalId: string, chunk: number): string {
  const digest = createHash('sha256')
    .update(`${projectId}:${externalId}:${chunk}`)
    .digest();
  const hex = digest.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function chunkText(text: string, target = CHUNK_TARGET, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= target) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + target, clean.length);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf(' ', end);
      if (boundary > start + target * 0.6) end = boundary;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

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

  private assertConfigured() {
    if (!this.client) {
      throw new Error('Qdrant is not configured: set QDRANT_URL and QDRANT_API_KEY');
    }
    if (!this.embedder) {
      throw new Error(
        'No embedding provider configured: set EMBEDDINGS_API_KEY (and optionally EMBEDDINGS_BASE_URL / EMBEDDINGS_MODEL)',
      );
    }
  }

  async ensureProject(_ctx: ProviderContext): Promise<void> {
    this.assertConfigured();
    await this.client!.ensureCollection(COLLECTION, this.embedder!.dimensions);
  }

  async index(ctx: ProviderContext, documents: KnowledgeDocumentInput[]): Promise<{ indexed: number }> {
    this.assertConfigured();
    const points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> = [];
    for (const doc of documents) {
      const chunks = chunkText(doc.text);
      if (chunks.length === 0) continue;
      const embeddings = await this.embedder!.embed(chunks);
      chunks.forEach((text, i) => {
        points.push({
          id: deterministicId(ctx.projectId, doc.externalId, i),
          vector: embeddings[i] ?? [],
          payload: {
            project_id: ctx.projectId,
            external_id: doc.externalId,
            kind: doc.kind,
            title: doc.title ?? null,
            url: doc.url ?? null,
            text,
            chunk_index: i,
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

  async reindex(ctx: ProviderContext, documents: KnowledgeDocumentInput[]): Promise<{ indexed: number; deleted: number }> {
    this.assertConfigured();
    await this.client!.deleteByFilter(COLLECTION, {
      must: [matchOn('project_id', ctx.projectId)],
    });
    const { indexed } = await this.index(ctx, documents);
    return { indexed, deleted: -1 };
  }

  async delete(ctx: ProviderContext, externalId: string): Promise<void> {
    this.assertConfigured();
    await this.client!.deleteByFilter(COLLECTION, {
      must: [matchOn('project_id', ctx.projectId), matchOn('external_id', externalId)],
    });
  }

  async deleteProject(ctx: ProviderContext): Promise<void> {
    this.assertConfigured();
    await this.client!.deleteByFilter(COLLECTION, {
      must: [matchOn('project_id', ctx.projectId)],
    });
  }

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
