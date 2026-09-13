/**
 * Canonical retrieval identity helpers (KB10).
 *
 * A candidate's identity is the pair (sourceId, chunkId), never its content
 * string: two retrieval origins can surface the exact same chunk with different
 * similarity text, and only identity may collapse them into one result. These
 * helpers are pure and dependency-free so the vector adapter, the lexical
 * adapter and the fusion step all agree on the same key.
 */

/** Managed source ids live in the index as `source:<uuid>` external ids. */
const MANAGED_SOURCE_EXTERNAL_ID =
  /^source:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Stable Qdrant external id for a knowledge source. */
export function sourceExternalId(sourceId: string): string {
  return `source:${sourceId}`;
}

/** Managed source UUID from a hit's `source:<uuid>` external id, else null. */
export function managedSourceIdFromPayload(payload: Record<string, unknown>): string | null {
  const raw =
    typeof payload.source_id === 'string'
      ? payload.source_id
      : typeof payload.external_id === 'string'
        ? payload.external_id
        : '';
  const match = MANAGED_SOURCE_EXTERNAL_ID.exec(raw.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** 0-based chunk index recorded by a provider, or null when absent. */
export function chunkIndexFromPayload(payload: Record<string, unknown>): number | null {
  const value = Number(payload.chunk_index);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Canonical dedup key for a candidate: `sourceId::chunkId`. A null chunk id
 * (source-granular hits) is a distinct identity from any numbered chunk so it
 * is never silently merged with one.
 */
export function candidateKey(sourceId: string, chunkId: string | number | null): string {
  return `${sourceId}::${chunkId === null || chunkId === undefined ? '' : String(chunkId)}`;
}
