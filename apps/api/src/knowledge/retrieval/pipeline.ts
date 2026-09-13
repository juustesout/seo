/**
 * Hybrid retrieval pipeline (KB10).
 *
 * Orchestrates the two candidate origins and fuses them. This is the only place
 * that decides which origins run and how failures degrade; the origins
 * themselves only supply candidates. Fail-closed rules:
 *   - both origins fail            -> the request fails (canonical search error)
 *   - one origin fails (hybrid)    -> the surviving origin's candidates are used
 *   - a single-origin result       -> returned unchanged (no RRF re-scoring)
 * The public DTO is untouched: the service maps the fused candidates back onto
 * the stable response shape and owns attribution.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { KnowledgeProvider } from '@seo/contracts';
import { logger } from '../../logger.js';
import { fuseCandidates } from './fusion.js';
import { KNOWLEDGE_RETRIEVAL_VECTOR_CANDIDATES } from './limits.js';
import { retrieveLexicalCandidates } from './lexical.js';
import { retrieveVectorCandidates } from './vector.js';
import type { KnowledgeCandidate, RetrievalOutcome, RetrievalRequest } from './types.js';

export interface RetrievalDependencies {
  provider: KnowledgeProvider;
  sb: SupabaseClient;
}

export async function retrieveCandidates(
  deps: RetrievalDependencies,
  request: RetrievalRequest,
): Promise<RetrievalOutcome> {
  if (request.mode === 'vector') {
    // Safe fallback: the previous vector-only behavior, including its errors.
    const candidates = await retrieveVectorCandidates(deps.provider, request, request.limit);
    return {
      candidates,
      diagnostics: {
        mode: 'vector',
        vectorCandidates: candidates.length,
        lexicalCandidates: 0,
        fused: false,
        vectorFailed: false,
        lexicalFailed: false,
      },
    };
  }

  const vectorLimit = KNOWLEDGE_RETRIEVAL_VECTOR_CANDIDATES;
  const [vectorResult, lexicalResult] = await Promise.allSettled([
    retrieveVectorCandidates(deps.provider, request, vectorLimit),
    retrieveLexicalCandidates(deps.sb, request),
  ]);

  const vectorFailed = vectorResult.status === 'rejected';
  const lexicalFailed = lexicalResult.status === 'rejected';
  if (vectorFailed && lexicalFailed) {
    // Surface the provider failure so the service maps it to the canonical
    // search error (never a database/RPC error body).
    throw vectorResult.reason;
  }
  if (vectorFailed) {
    logger.warn({ err: vectorResult.reason }, 'knowledge vector retrieval failed; degrading to lexical candidates');
  }
  if (lexicalFailed) {
    logger.warn({ err: lexicalResult.reason }, 'knowledge lexical retrieval failed; degrading to vector candidates');
  }

  const vectorCandidates: KnowledgeCandidate[] = vectorResult.status === 'fulfilled' ? vectorResult.value : [];
  const lexicalCandidates: KnowledgeCandidate[] = lexicalResult.status === 'fulfilled' ? lexicalResult.value : [];
  const { candidates, fused } = fuseCandidates(vectorCandidates, lexicalCandidates);

  return {
    candidates,
    diagnostics: {
      mode: 'hybrid',
      vectorCandidates: vectorCandidates.length,
      lexicalCandidates: lexicalCandidates.length,
      fused,
      vectorFailed,
      lexicalFailed,
    },
  };
}
