/**
 * Metadata-aware candidate reconciliation (KB10.2).
 *
 * Runs after both origins have produced candidates and BEFORE fusion. The
 * vector origin cannot filter on Postgres lifecycle (a point has no `status`),
 * so this step resolves each candidate's managed source facts from Postgres and
 * drops anything that is not a `ready`, in-scope source. System-indexed
 * knowledge is kept only when the scope is not managed-only - a collection or
 * freshness filter must never silently include system documents through their
 * `collection_id = null` payload.
 *
 * Filtering here (rather than after fusion) means the RRF candidate budgets are
 * spent on the canonical universe, and no non-ready or out-of-scope chunk can
 * influence a fused rank.
 */

import { managedSourceIdFromPayload } from './identity.js';
import {
  scopeAllowsManagedFacts,
  scopeAllowsSystemKnowledge,
  type KnowledgeRetrievalScope,
} from './scope.js';
import type { ManagedSourceFacts } from './sourceFacts.js';
import type { KnowledgeCandidate } from './types.js';

/** Managed source UUIDs referenced by a candidate list (deduplicated). */
export function managedIdsFromCandidates(candidates: readonly KnowledgeCandidate[]): string[] {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const id = managedSourceIdFromPayload(candidate.payload);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Keep only candidates that satisfy the canonical scope. Managed candidates
 * need a resolved `ready` fact set that passes every scope constraint; system
 * candidates are dropped under a managed-only scope. Missing facts fail closed.
 */
export function filterCandidatesToScope(
  scope: KnowledgeRetrievalScope,
  candidates: readonly KnowledgeCandidate[],
  facts: ReadonlyMap<string, ManagedSourceFacts>,
): KnowledgeCandidate[] {
  const kept: KnowledgeCandidate[] = [];
  for (const candidate of candidates) {
    const managedId = managedSourceIdFromPayload(candidate.payload);
    if (!managedId) {
      if (scopeAllowsSystemKnowledge(scope)) kept.push(candidate);
      continue;
    }
    const sourceFacts = facts.get(managedId);
    if (sourceFacts && scopeAllowsManagedFacts(scope, sourceFacts)) kept.push(candidate);
  }
  return kept;
}
