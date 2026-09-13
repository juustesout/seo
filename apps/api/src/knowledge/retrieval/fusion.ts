/**
 * Deterministic reciprocal rank fusion (KB10).
 *
 * `score(d) = sum(1 / (k + rank_i(d)))` over every origin list, where `rank_i`
 * is the candidate's 1-based position in that origin. Fusing by rank (not by
 * raw score) means a cosine score and a `ts_rank` value never have to be
 * calibrated against each other. Candidates are deduplicated by canonical
 * identity (sourceId + chunkId), never by content string.
 *
 * Degraded paths: when only one origin produced candidates the list is returned
 * unchanged (original scores and order), so a request that loses one origin
 * behaves exactly as that origin did before the hybrid pipeline existed.
 */

import { KNOWLEDGE_RETRIEVAL_FUSED_CANDIDATES, KNOWLEDGE_RETRIEVAL_RRF_K } from './limits.js';
import type { KnowledgeCandidate } from './types.js';

export interface FusionResult {
  candidates: KnowledgeCandidate[];
  /** True only when both origins contributed and RRF actually ran. */
  fused: boolean;
}

export function fuseCandidates(
  vector: KnowledgeCandidate[],
  lexical: KnowledgeCandidate[],
  options: { k?: number; limit?: number } = {},
): FusionResult {
  const k = options.k ?? KNOWLEDGE_RETRIEVAL_RRF_K;
  const limit = options.limit ?? KNOWLEDGE_RETRIEVAL_FUSED_CANDIDATES;

  if (lexical.length === 0) return { candidates: vector.slice(0, limit), fused: false };
  if (vector.length === 0) return { candidates: lexical.slice(0, limit), fused: false };

  const scores = new Map<string, number>();
  const chosen = new Map<string, KnowledgeCandidate>();
  const absorb = (list: KnowledgeCandidate[]) => {
    list.forEach((candidate, index) => {
      scores.set(candidate.key, (scores.get(candidate.key) ?? 0) + 1 / (k + index + 1));
      const current = chosen.get(candidate.key);
      if (!current || preferCandidate(candidate, current)) chosen.set(candidate.key, candidate);
    });
  };
  absorb(vector);
  absorb(lexical);

  const candidates = [...scores.entries()]
    .map(([key, score]) => ({ ...chosen.get(key)!, score }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, limit);
  return { candidates, fused: true };
}

/**
 * Which duplicate identity wins when both origins surface the same chunk.
 * Prefer the vector payload (the provider's canonical indexed text); otherwise
 * keep the candidate with the higher origin-local score. Deterministic because
 * ties are resolved by origin order and the final sort breaks score ties by key.
 */
function preferCandidate(next: KnowledgeCandidate, current: KnowledgeCandidate): boolean {
  if (next.origin !== current.origin) return next.origin === 'vector';
  return next.score > current.score;
}
