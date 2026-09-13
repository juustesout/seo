/**
 * Deterministic retrieval query plan (KB10.2).
 *
 * A plan is built once per request from already-normalized, already-bounded
 * input: the canonical query, the canonical metadata scope, which origins run,
 * and the candidate budgets. It is not an AI agent and takes no decisions
 * beyond fixed allowlisted rules over explicit filters and known metadata. The
 * test suite treats it as immutable (deep-frozen).
 *
 * `retrieval` starts conservative: vector always runs; lexical runs only in
 * hybrid mode. There are deliberately no query-shaping heuristics (no "short
 * query means lexical only") - KB10.2 is about metadata-aware scope, not guesses
 * about language.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  KNOWLEDGE_RETRIEVAL_FUSED_CANDIDATES,
  KNOWLEDGE_RETRIEVAL_LEXICAL_CANDIDATES,
  KNOWLEDGE_RETRIEVAL_VECTOR_CANDIDATES,
} from './limits.js';
import { buildRetrievalScope, type KnowledgeRetrievalScope, type RetrievalScopeInput } from './scope.js';
import type { RetrievalMode } from './types.js';

export interface KnowledgeQueryPlan {
  readonly projectId: string;
  /** Canonical normalized query, shared by every origin and the response. */
  readonly query: string;
  /** Clamped public result limit (post-fusion). */
  readonly limit: number;
  readonly mode: RetrievalMode;
  /** Which origins the plan activates. */
  readonly retrieval: { readonly vector: boolean; readonly lexical: boolean };
  /** Canonical effective metadata scope, projected onto both origins. */
  readonly scope: KnowledgeRetrievalScope;
  /** Per-origin / fused candidate budgets (central limits, never per-request). */
  readonly budgets: { readonly vector: number; readonly lexical: number; readonly fused: number };
}

export interface QueryPlanInput {
  projectId: string;
  /** Already normalized and verified non-empty by the caller. */
  query: string;
  /** Already clamped by the caller. */
  limit: number;
  mode: RetrievalMode;
  /** Raw allowlisted filter input; validated here into the canonical scope. */
  filter?: RetrievalScopeInput;
}

/**
 * Build the immutable plan for one retrieval request. Scope resolution is the
 * only async step (a derived freshness filter reads the project's source facts);
 * all validation failures surface as `RetrievalScopeError` for the service to
 * map to a clean API error.
 */
export async function buildKnowledgeQueryPlan(
  sb: SupabaseClient,
  input: QueryPlanInput,
): Promise<KnowledgeQueryPlan> {
  const scope = await buildRetrievalScope(sb, input.projectId, input.filter ?? {});
  return Object.freeze({
    projectId: input.projectId,
    query: input.query,
    limit: input.limit,
    mode: input.mode,
    retrieval: Object.freeze({ vector: true, lexical: input.mode === 'hybrid' }),
    scope,
    budgets: Object.freeze({
      vector: KNOWLEDGE_RETRIEVAL_VECTOR_CANDIDATES,
      lexical: KNOWLEDGE_RETRIEVAL_LEXICAL_CANDIDATES,
      fused: KNOWLEDGE_RETRIEVAL_FUSED_CANDIDATES,
    }),
  });
}
