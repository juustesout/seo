/**
 * Postgres lexical retrieval + its derived chunk projection (KB10).
 *
 * The lexical origin is Postgres-native full-text search - there is deliberately
 * no third datastore. A small derived projection table
 * (`seo_knowledge_lexical_chunks`) holds the same bounded chunks that are sent
 * to the vector provider, so lexical hits share the vector index's identity
 * (sourceId + chunk index) and can be fused chunk-for-chunk. The projection is
 * derived from the canonical source body, written on the same successful
 * ingest/refresh that writes vectors, cascade-deleted with the source row and
 * wiped with the project - it is never authored independently.
 *
 * Search is a single ranked RPC that joins the source row so project isolation,
 * the `ready` lifecycle gate and every allowlisted filter are applied in the
 * database before any candidate reaches fusion.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkKnowledgeText } from '../chunker.js';
import { candidateKey, sourceExternalId } from './identity.js';
import type { KnowledgeQueryPlan } from './plan.js';
import { toLexicalParams } from './scope.js';
import type { KnowledgeCandidate } from './types.js';

/** Rows returned by the `seo_knowledge_lexical_search` RPC. */
interface LexicalRow {
  source_id: string;
  chunk_index: number;
  score: number;
  content: string;
}

/** Batch size for projection writes; MAX_CHUNKS (400) stays within one call. */
const PROJECTION_BATCH = 200;

/**
 * Replace the lexical projection for one source with the chunks of `text`.
 * Called only after a successful ingest/refresh commit. Throws on storage
 * failure so the caller can decide (the service treats it as best effort).
 */
export async function replaceLexicalChunks(
  sb: SupabaseClient,
  projectId: string,
  sourceId: string,
  text: string,
): Promise<number> {
  const chunks = chunkKnowledgeText(text);
  const { error: deleteError } = await sb
    .from('seo_knowledge_lexical_chunks')
    .delete()
    .eq('project_id', projectId)
    .eq('source_id', sourceId);
  if (deleteError) throw new Error(deleteError.message);
  if (chunks.length === 0) return 0;

  const rows = chunks.map((content, index) => ({
    project_id: projectId,
    source_id: sourceId,
    chunk_index: index,
    content,
  }));
  for (let i = 0; i < rows.length; i += PROJECTION_BATCH) {
    const { error } = await sb.from('seo_knowledge_lexical_chunks').insert(rows.slice(i, i + PROJECTION_BATCH));
    if (error) throw new Error(error.message);
  }
  return rows.length;
}

/**
 * Drop one source's lexical projection. The database cascade also handles this
 * when the source row is deleted; calling it explicitly keeps deletion correct
 * even if the projection was written by an earlier schema and makes the
 * lifecycle observable to unit tests.
 */
export async function clearSourceLexicalChunks(
  sb: SupabaseClient,
  projectId: string,
  sourceId: string,
): Promise<void> {
  const { error } = await sb
    .from('seo_knowledge_lexical_chunks')
    .delete()
    .eq('project_id', projectId)
    .eq('source_id', sourceId);
  if (error) throw new Error(error.message);
}

/**
 * Drop every lexical chunk of a project. Used after a project-wide vector wipe
 * so the two derived indexes cannot drift; the source rows (and their captured
 * text) are the rebuild source.
 */
export async function clearProjectLexicalChunks(sb: SupabaseClient, projectId: string): Promise<void> {
  const { error } = await sb.from('seo_knowledge_lexical_chunks').delete().eq('project_id', projectId);
  if (error) throw new Error(error.message);
}

/**
 * Query the lexical index for a bounded, filtered, ranked candidate list. The
 * canonical plan scope is projected onto the RPC parameters so Postgres filters
 * on exactly the same universe (collection, uncategorized, source type, source
 * ids) as the vector origin. Throws on any database/RPC failure so the pipeline
 * can degrade to vector.
 */
export async function retrieveLexicalCandidates(
  sb: SupabaseClient,
  plan: KnowledgeQueryPlan,
): Promise<KnowledgeCandidate[]> {
  const params = toLexicalParams(plan.scope);

  const { data, error } = await sb.rpc('seo_knowledge_lexical_search', {
    p_project: plan.projectId,
    p_query: plan.query,
    p_limit: plan.budgets.lexical,
    p_source_ids: params.sourceIds,
    p_source_types: params.sourceTypes,
    p_collection_id: params.collectionId,
    p_uncategorized: params.uncategorized,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as LexicalRow[];
  const candidates: KnowledgeCandidate[] = [];
  for (const row of rows) {
    const sourceId = String(row.source_id);
    const chunkId = String(row.chunk_index);
    candidates.push({
      key: candidateKey(sourceId, chunkId),
      sourceId,
      chunkId,
      origin: 'lexical',
      content: row.content,
      score: Number(row.score),
      payload: {
        source_id: sourceExternalId(sourceId),
        external_id: sourceExternalId(sourceId),
        text: row.content,
        chunk_index: row.chunk_index,
      },
    });
  }
  return candidates;
}
