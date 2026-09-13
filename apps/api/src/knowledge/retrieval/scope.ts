/**
 * Canonical retrieval scope (KB10.2).
 *
 * The scope is the single, narrowed universe a search may draw from. It is
 * derived only from explicit request filters plus bounded, deterministic rules
 * over known metadata - there is no AI in this file. Both the vector adapter
 * and the lexical adapter project the SAME scope onto their own query language,
 * so Qdrant can never search collection A while Postgres searches collection A
 * plus B.
 *
 * Explicit filters always win: the scope may normalize/combine them, but it can
 * never widen them. A derived filter (freshness) is resolved to a bounded set of
 * managed source ids via the single `computeFreshness` owner; if that set cannot
 * be bounded, the request fails closed instead of silently ignoring the filter.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { KnowledgeFreshnessState, KnowledgeSearchFilter } from '@seo/contracts';
import { KNOWLEDGE_FRESHNESS_STATES } from '@seo/contracts';
import { computeFreshness, type FreshnessFacts } from '../freshness.js';
import { sourceExternalId } from './identity.js';
import { KNOWLEDGE_RETRIEVAL_MAX_SCOPE_SOURCES } from './limits.js';
import type { ManagedSourceFacts } from './sourceFacts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A canonical-scope violation. Carried out of the retrieval boundary and mapped
 * by the service to a clean ApiError; an invalid or too-broad scope is a
 * fail-closed request error, never a silently broadened search.
 */
export class RetrievalScopeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'RetrievalScopeError';
  }
}

/** Allowlisted filters accepted from a caller (unvalidated). */
export interface RetrievalScopeInput {
  sourceTypes?: readonly string[];
  /** Managed source UUIDs (not `source:<id>` external ids). */
  sourceIds?: readonly string[];
  collectionId?: string;
  uncategorized?: boolean;
  freshness?: readonly string[];
}

/**
 * The immutable, effective retrieval scope. `effectiveSourceIds` is the final
 * managed-source allowlist (explicit ids intersected with any derived scope, or
 * the derived scope itself), or null when the search is not restricted by
 * source id. `empty` means the scope provably matches nothing.
 */
export interface KnowledgeRetrievalScope {
  readonly collectionId: string | null;
  readonly uncategorized: boolean;
  readonly sourceTypes: readonly string[];
  readonly freshness: readonly KnowledgeFreshnessState[];
  /** Explicitly requested managed source UUIDs (deduplicated). */
  readonly requestedSourceIds: readonly string[];
  /** Final managed source UUID allowlist, or null when unrestricted by id. */
  readonly effectiveSourceIds: readonly string[] | null;
  /** True when at least one managed-metadata filter is active. */
  readonly managedOnly: boolean;
  /** True when the scope provably matches nothing (no origin call needed). */
  readonly empty: boolean;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Resolve a derived (freshness) filter to a bounded set of managed source ids.
 * Reads only this project's `ready` sources, applying the explicit filters first
 * so the scan is as small as possible, and runs the single `computeFreshness`
 * owner - never a second freshness calculator. Fails closed when the candidate
 * set exceeds the central bound.
 */
async function resolveFreshnessSourceIds(
  sb: SupabaseClient,
  projectId: string,
  input: {
    freshness: readonly KnowledgeFreshnessState[];
    sourceIds: readonly string[];
    sourceTypes: readonly string[];
    collectionId: string | null;
    uncategorized: boolean;
  },
): Promise<string[]> {
  let q = sb
    .from('seo_knowledge_sources')
    .select(
      'id, source_type, status, collection_id, refresh_policy, last_fetched_at, last_changed_at, next_refresh_at, refresh_failures',
    )
    .eq('project_id', projectId)
    .eq('status', 'ready');
  if (input.sourceIds.length > 0) q = q.in('id', [...input.sourceIds]);
  if (input.collectionId) q = q.eq('collection_id', input.collectionId);
  else if (input.uncategorized) q = q.is('collection_id', null);
  if (input.sourceTypes.length > 0) q = q.in('source_type', [...input.sourceTypes]);

  const { data, error } = await q
    .order('id', { ascending: true })
    .limit(KNOWLEDGE_RETRIEVAL_MAX_SCOPE_SOURCES + 1);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length > KNOWLEDGE_RETRIEVAL_MAX_SCOPE_SOURCES) {
    throw new RetrievalScopeError(
      'knowledge_scope_too_broad',
      'This freshness filter matches too many sources to search efficiently. Narrow it with a collection or source type.',
    );
  }

  const wanted = new Set(input.freshness);
  const now = new Date();
  const matched: string[] = [];
  for (const row of rows) {
    const facts: FreshnessFacts = {
      sourceType: (row.source_type as FreshnessFacts['sourceType']) ?? 'text',
      status: (row.status as FreshnessFacts['status']) ?? 'draft',
      refreshPolicy: row.refresh_policy,
      lastFetchedAt: row.last_fetched_at ? String(row.last_fetched_at) : null,
      lastChangedAt: row.last_changed_at ? String(row.last_changed_at) : null,
      nextRefreshAt: row.next_refresh_at ? String(row.next_refresh_at) : null,
      refreshFailures: Number(row.refresh_failures ?? 0),
    };
    if (wanted.has(computeFreshness(facts, now).state)) matched.push(String(row.id));
  }
  return matched;
}

/**
 * Validate a raw filter input and build the canonical, immutable scope. Only
 * explicit filters and bounded derived rules are used; an unknown or malformed
 * value is rejected rather than ignored.
 */
export async function buildRetrievalScope(
  sb: SupabaseClient,
  projectId: string,
  input: RetrievalScopeInput,
): Promise<KnowledgeRetrievalScope> {
  const collectionId = typeof input.collectionId === 'string' ? input.collectionId.trim() : '';
  if (collectionId && !UUID.test(collectionId)) {
    throw new RetrievalScopeError('bad_request', 'Invalid collection id filter');
  }
  if (collectionId && input.uncategorized) {
    throw new RetrievalScopeError('bad_request', 'collection_id and uncategorized are mutually exclusive');
  }

  const requestedSourceIds = uniqueStrings(input.sourceIds);
  if (requestedSourceIds.some((id) => !UUID.test(id))) {
    throw new RetrievalScopeError('bad_request', 'Invalid source id filter');
  }

  const requestedFreshness = uniqueStrings(input.freshness);
  const invalidFreshness = requestedFreshness.filter(
    (state) => !(KNOWLEDGE_FRESHNESS_STATES as readonly string[]).includes(state),
  );
  if (invalidFreshness.length > 0) {
    throw new RetrievalScopeError('bad_request', 'Invalid freshness filter');
  }
  const freshness = requestedFreshness as KnowledgeFreshnessState[];

  const sourceTypes = uniqueStrings(input.sourceTypes);
  const uncategorized = input.uncategorized === true;

  let allowedSourceIds: string[] | null = null;
  if (freshness.length > 0) {
    allowedSourceIds = await resolveFreshnessSourceIds(sb, projectId, {
      freshness,
      sourceIds: requestedSourceIds,
      sourceTypes,
      collectionId: collectionId || null,
      uncategorized,
    });
  }

  let effectiveSourceIds: string[] | null = null;
  if (allowedSourceIds !== null) {
    const allowed = new Set(allowedSourceIds);
    effectiveSourceIds = requestedSourceIds.length > 0 ? requestedSourceIds.filter((id) => allowed.has(id)) : allowedSourceIds;
  } else if (requestedSourceIds.length > 0) {
    effectiveSourceIds = requestedSourceIds;
  }

  const managedOnly =
    collectionId.length > 0 || uncategorized || sourceTypes.length > 0 || effectiveSourceIds !== null;
  const empty = allowedSourceIds !== null && (effectiveSourceIds?.length ?? 0) === 0;

  return Object.freeze({
    collectionId: collectionId || null,
    uncategorized,
    sourceTypes: Object.freeze([...sourceTypes]),
    freshness: Object.freeze([...freshness]),
    requestedSourceIds: Object.freeze([...requestedSourceIds]),
    effectiveSourceIds: effectiveSourceIds === null ? null : Object.freeze([...effectiveSourceIds]),
    managedOnly,
    empty,
  });
}

/**
 * Project the canonical scope onto the provider filter allowlist (Qdrant
 * shape). Source UUIDs become the provider's `source:<id>` external ids. An
 * empty scope never reaches here (the pipeline short-circuits); an unrestricted
 * scope returns undefined so no filter key is forwarded.
 */
export function toProviderSearchFilter(scope: KnowledgeRetrievalScope): KnowledgeSearchFilter | undefined {
  const filter: KnowledgeSearchFilter = {};
  if (scope.collectionId) filter.collectionId = scope.collectionId;
  else if (scope.uncategorized) filter.uncategorized = true;
  if (scope.sourceTypes.length > 0) filter.sourceTypes = [...scope.sourceTypes];
  if (scope.effectiveSourceIds) filter.sourceIds = scope.effectiveSourceIds.map(sourceExternalId);
  return Object.keys(filter).length > 0 ? filter : undefined;
}

/**
 * Project the canonical scope onto the lexical (Postgres RPC) parameters.
 * Postgres speaks raw managed source UUIDs, so the same scope produces the same
 * universe as the vector projection above.
 */
export function toLexicalParams(scope: KnowledgeRetrievalScope): {
  sourceIds: string[] | null;
  sourceTypes: string[] | null;
  collectionId: string | null;
  uncategorized: boolean;
} {
  return {
    sourceIds: scope.effectiveSourceIds && scope.effectiveSourceIds.length > 0 ? [...scope.effectiveSourceIds] : null,
    sourceTypes: scope.sourceTypes.length > 0 ? [...scope.sourceTypes] : null,
    collectionId: scope.collectionId,
    uncategorized: scope.uncategorized,
  };
}

/** True when the scope's metadata/lifecycle constraints are satisfied by a managed source. */
export function scopeAllowsManagedFacts(scope: KnowledgeRetrievalScope, facts: ManagedSourceFacts): boolean {
  if (facts.status !== 'ready') return false;
  if (scope.collectionId && facts.collectionId !== scope.collectionId) return false;
  if (scope.uncategorized && facts.collectionId !== null) return false;
  if (scope.sourceTypes.length > 0 && !scope.sourceTypes.includes(facts.sourceType)) return false;
  if (scope.effectiveSourceIds && !scope.effectiveSourceIds.includes(facts.id)) return false;
  return true;
}

/** Managed sources are the only thing a managed-metadata filter can target. */
export function scopeAllowsSystemKnowledge(scope: KnowledgeRetrievalScope): boolean {
  return !scope.managedOnly;
}
