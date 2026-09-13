/**
 * Vector candidate retrieval (KB10).
 *
 * Wraps the registered `KnowledgeProvider.search` unchanged: project isolation,
 * provider filters, attribution metadata and fail-closed behavior all stay in
 * the provider/service. The adapter only converts provider hits into the
 * canonical internal candidate shape (identity + bounded content) and asks for
 * a bounded candidate window instead of the public result limit, so fusion has
 * a real pool to rank while the provider is never asked for an unbounded list.
 */

import type { KnowledgeProvider, KnowledgeSearchFilter, KnowledgeSearchResult } from '@seo/contracts';
import { buildSearchContent } from './content.js';
import { candidateKey, chunkIndexFromPayload, managedSourceIdFromPayload } from './identity.js';
import type { KnowledgeCandidate } from './types.js';

/** Convert one provider hit into a candidate, or null when it has no content. */
export function vectorHitToCandidate(hit: KnowledgeSearchResult): KnowledgeCandidate | null {
  const payload = (hit.payload ?? {}) as Record<string, unknown>;
  const content = buildSearchContent(payload);
  if (!content) return null;

  const managedId = managedSourceIdFromPayload(payload);
  const sourceId = managedId ?? (typeof payload.source_id === 'string' ? payload.source_id.trim() : '');
  // An unattributable hit is dropped downstream; give it a per-hit identity so
  // unrelated empty-source hits can never collapse into one candidate.
  const identity = sourceId || `point:${hit.id}`;
  const chunkIndex = chunkIndexFromPayload(payload);
  const chunkId = chunkIndex === null ? null : String(chunkIndex);

  return {
    key: candidateKey(identity, chunkId),
    sourceId,
    chunkId,
    origin: 'vector',
    content,
    score: Number(hit.score),
    payload,
  };
}

/** Ask the provider for up to `candidateLimit` vector candidates. */
export async function retrieveVectorCandidates(
  provider: KnowledgeProvider,
  request: { projectId: string; query: string; filter?: KnowledgeSearchFilter },
  candidateLimit: number,
): Promise<KnowledgeCandidate[]> {
  const hits = await provider.search({
    projectId: request.projectId,
    query: request.query,
    limit: candidateLimit,
    filter: request.filter,
  });
  const candidates: KnowledgeCandidate[] = [];
  for (const hit of hits) {
    const candidate = vectorHitToCandidate(hit);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
