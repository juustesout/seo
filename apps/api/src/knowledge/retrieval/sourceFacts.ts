/**
 * Managed source facts for retrieval (KB10.2).
 *
 * Postgres is the source of truth for a managed source's lifecycle and
 * organizational metadata, so the retrieval boundary resolves those facts from
 * `seo_knowledge_sources` instead of trusting the vector payload (which can be
 * stale) or duplicating them into the index. Loading is project-scoped and
 * bounded by the candidate source ids it is asked about, never by a project
 * scan, so it cannot grow with the size of the knowledge base.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { KnowledgeSourceStatus, KnowledgeSourceType } from '@seo/contracts';

/** Safe, retrieval-relevant facts of one managed source. No body, no secrets. */
export interface ManagedSourceFacts {
  id: string;
  name: string;
  sourceType: KnowledgeSourceType;
  url: string | null;
  status: KnowledgeSourceStatus;
  collectionId: string | null;
  collectionName: string | null;
}

/** Columns loaded per source; `collection` is the embedded to-one relation. */
const SOURCE_FACTS_COLUMNS = 'id, name, source_type, url, status, collection_id, collection:seo_knowledge_collections(name)';

/** Resolve facts for a bounded set of managed source ids (project-scoped). */
export type ManagedSourceFactsLoader = (
  projectId: string,
  sourceIds: readonly string[],
) => Promise<Map<string, ManagedSourceFacts>>;

/** Collection display name from a PostgREST embedding (object or one-element array). */
function embeddedCollectionName(row: Record<string, unknown>): string | null {
  const rel = row.collection;
  const obj = Array.isArray(rel) ? rel[0] : rel;
  if (obj && typeof obj === 'object') {
    const name = (obj as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

/**
 * Load facts for the given managed source ids, scoped to one project. A source
 * from another project is simply absent from the result (fail closed: the
 * caller drops the candidate rather than leaking a foreign row).
 */
export async function loadManagedSourceFacts(
  sb: SupabaseClient,
  projectId: string,
  sourceIds: readonly string[],
): Promise<Map<string, ManagedSourceFacts>> {
  const unique = [...new Set(sourceIds.filter((id) => typeof id === 'string' && id.trim().length > 0))];
  const facts = new Map<string, ManagedSourceFacts>();
  if (unique.length === 0) return facts;

  const { data, error } = await sb
    .from('seo_knowledge_sources')
    .select(SOURCE_FACTS_COLUMNS)
    .eq('project_id', projectId)
    .in('id', unique);
  if (error) throw new Error(error.message);

  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const id = String(raw.id);
    const collectionId = raw.collection_id ? String(raw.collection_id) : null;
    facts.set(id, {
      id,
      name: String(raw.name ?? ''),
      sourceType: (raw.source_type as KnowledgeSourceType) ?? 'text',
      url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : null,
      status: (raw.status as KnowledgeSourceStatus) ?? 'draft',
      collectionId,
      collectionName: collectionId ? embeddedCollectionName(raw) : null,
    });
  }
  return facts;
}
