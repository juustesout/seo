/**
 * Central knowledge-source lifecycle (KB2).
 *
 * Postgres is the source of truth for a source's lifecycle; every status
 * change in the API, service and worker funnels through this map so the legal
 * transitions live in exactly one place. The canonical statuses are:
 *
 *   draft      -> stored, not ingestable yet (e.g. a URL awaiting fetch)
 *   queued     -> an ingest job is pending
 *   processing -> an ingest job is running
 *   ready      -> vectors exist for the current representation
 *   failed     -> the last ingest failed; see `error`
 *   deleted    -> terminal: the source is being/has been torn down
 *
 * Only these transitions are legal:
 *
 *   draft      -> queued, deleted
 *   queued     -> processing, queued (idempotent re-queue), deleted
 *   processing -> ready, failed, deleted
 *   ready      -> queued (reindex), deleted
 *   failed     -> queued (retry), processing (worker retry), deleted
 *   deleted    -> (terminal)
 *
 * Explicitly illegal (and the reason this module exists): draft->ready,
 * queued->ready and failed->ready (an unindexed/failed source may never claim
 * to be ready), and deleted->queued (a torn-down source can never come back).
 */

import type { KnowledgeSourceStatus } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';

/** All canonical statuses, in lifecycle order (used by validation/tests). */
export const KNOWLEDGE_STATUSES: readonly KnowledgeSourceStatus[] = [
  'draft',
  'queued',
  'processing',
  'ready',
  'failed',
  'deleted',
];

/**
 * The single source of legal transitions. Keep this exhaustive: every status
 * must appear as a key (TypeScript enforces it via the Record type).
 */
const ALLOWED_TRANSITIONS: Record<KnowledgeSourceStatus, readonly KnowledgeSourceStatus[]> = {
  draft: ['queued', 'deleted'],
  queued: ['processing', 'queued', 'deleted'],
  processing: ['ready', 'failed', 'deleted'],
  ready: ['queued', 'deleted'],
  failed: ['queued', 'processing', 'deleted'],
  deleted: [],
};

/** True when `from -> to` is a legal lifecycle transition. */
export function canTransition(from: KnowledgeSourceStatus, to: KnowledgeSourceStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Throws a 409 conflict when `from -> to` is not a legal transition. */
export function assertTransition(from: KnowledgeSourceStatus, to: KnowledgeSourceStatus): void {
  if (!canTransition(from, to)) {
    throw ApiError.conflict(`Cannot change this knowledge source from '${from}' to '${to}'.`);
  }
}

/** Terminal statuses: no further transition is legal. */
export function isTerminalStatus(status: KnowledgeSourceStatus): boolean {
  return status === 'deleted';
}

/**
 * Statuses a source may be (re)queued for ingestion from. Mirrors the `queued`
 * column of ALLOWED_TRANSITIONS so callers never hardcode the set.
 */
export function ingestableStatuses(): KnowledgeSourceStatus[] {
  return KNOWLEDGE_STATUSES.filter((status) => canTransition(status, 'queued'));
}
