/**
 * Hybrid retrieval pipeline (KB10/KB10.2).
 *
 * Orchestrates the two candidate origins, reconciles them against the canonical
 * retrieval scope, then fuses them. This is the only place that decides which
 * origins run and how failures degrade; the origins themselves only supply
 * candidates, and the reconcile step only narrows (never widens) their output.
 * Fail-closed rules:
 *   - both origins fail            -> the request fails (canonical search error)
 *   - one origin fails (hybrid)    -> the surviving origin's candidates are used
 *   - a single-origin result       -> returned unchanged (no RRF re-scoring)
 *   - an empty canonical scope     -> no origin is called (honest empty result)
 * Metadata-aware reconciliation happens BEFORE fusion, so budgets are spent on
 * the canonical universe and no non-ready/out-of-scope chunk can influence a
 * fused rank. The public DTO is untouched: the service maps the fused
 * candidates and the resolved source facts onto the stable response shape.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { KnowledgeProvider } from '@seo/contracts';
import { logger } from '../../logger.js';
import { fuseCandidates } from './fusion.js';
import { retrieveLexicalCandidates } from './lexical.js';
import type { KnowledgeQueryPlan } from './plan.js';
import { filterCandidatesToScope, managedIdsFromCandidates } from './reconcile.js';
import { loadManagedSourceFacts, type ManagedSourceFacts, type ManagedSourceFactsLoader } from './sourceFacts.js';
import type { KnowledgeCandidate, RetrievalOutcome } from './types.js';
import { retrieveVectorCandidates } from './vector.js';

export interface RetrievalDependencies {
  provider: KnowledgeProvider;
  sb: SupabaseClient;
  /** Injectable for tests; defaults to the project-scoped Postgres loader. */
  loadSourceFacts?: ManagedSourceFactsLoader;
}

function emptyOutcome(plan: KnowledgeQueryPlan): RetrievalOutcome {
  return {
    candidates: [],
    sourceFacts: new Map(),
    diagnostics: {
      mode: plan.mode,
      vectorCandidates: 0,
      lexicalCandidates: 0,
      fused: false,
      vectorFailed: false,
      lexicalFailed: false,
      derivedScope: plan.scope.freshness.length > 0,
    },
  };
}

export async function retrieveCandidates(
  deps: RetrievalDependencies,
  plan: KnowledgeQueryPlan,
): Promise<RetrievalOutcome> {
  // A provably empty scope (e.g. a freshness filter with no matching ready
  // source) means there is nothing to retrieve; do not call any origin.
  if (plan.scope.empty) return emptyOutcome(plan);

  const loadFacts: ManagedSourceFactsLoader =
    deps.loadSourceFacts ?? ((projectId, ids) => loadManagedSourceFacts(deps.sb, projectId, ids));

  if (!plan.retrieval.lexical) {
    // Safe fallback: the previous vector-only behavior, including its errors.
    const candidates = await retrieveVectorCandidates(deps.provider, plan, plan.limit);
    const sourceFacts = await resolveFacts(loadFacts, plan, candidates);
    return {
      candidates: filterCandidatesToScope(plan.scope, candidates, sourceFacts),
      sourceFacts,
      diagnostics: {
        mode: plan.mode,
        vectorCandidates: candidates.length,
        lexicalCandidates: 0,
        fused: false,
        vectorFailed: false,
        lexicalFailed: false,
        derivedScope: plan.scope.freshness.length > 0,
      },
    };
  }

  const [vectorResult, lexicalResult] = await Promise.allSettled([
    retrieveVectorCandidates(deps.provider, plan, plan.budgets.vector),
    retrieveLexicalCandidates(deps.sb, plan),
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

  const vectorRaw: KnowledgeCandidate[] = vectorResult.status === 'fulfilled' ? vectorResult.value : [];
  const lexicalRaw: KnowledgeCandidate[] = lexicalResult.status === 'fulfilled' ? lexicalResult.value : [];

  const union = [...vectorRaw, ...lexicalRaw];
  const sourceFacts = await resolveFacts(loadFacts, plan, union);
  const vectorCandidates = filterCandidatesToScope(plan.scope, vectorRaw, sourceFacts);
  const lexicalCandidates = filterCandidatesToScope(plan.scope, lexicalRaw, sourceFacts);
  const { candidates, fused } = fuseCandidates(vectorCandidates, lexicalCandidates, {
    limit: plan.budgets.fused,
  });

  return {
    candidates,
    sourceFacts,
    diagnostics: {
      mode: plan.mode,
      vectorCandidates: vectorCandidates.length,
      lexicalCandidates: lexicalCandidates.length,
      fused,
      vectorFailed,
      lexicalFailed,
      derivedScope: plan.scope.freshness.length > 0,
    },
  };
}

/** Load managed facts for every managed source referenced by the candidates. */
async function resolveFacts(
  loadFacts: ManagedSourceFactsLoader,
  plan: KnowledgeQueryPlan,
  candidates: readonly KnowledgeCandidate[],
): Promise<Map<string, ManagedSourceFacts>> {
  const ids = managedIdsFromCandidates(candidates);
  if (ids.length === 0) return new Map();
  return loadFacts(plan.projectId, ids);
}
