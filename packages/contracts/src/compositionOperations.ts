/**
 * Composer operation batch (R5.4.4).
 *
 * The Composer-level handoff between a generated composition and the unified
 * workspace document. It is a proposal/command payload, not an apply: the
 * existing `CompositionApplyBridge` still executes it against the one open
 * document, and the existing `DocumentOperationBatch` still carries the
 * operations once the workspace binds them to a document revision.
 *
 * It wraps, and does not duplicate:
 *   - `mapCompositionToAppendOperations` for the composition -> operations map,
 *   - `DocumentOperation` for the operation vocabulary,
 *   - `CompositionGap` for unsupported/unmatched structures,
 *   - `CompositionPlan` for the composition identity, when the caller has it.
 *
 * The batch deliberately carries no `baseRevision`: the Composer is
 * document-independent and never owns document identity. The workspace binds the
 * open document's revision when it stages the batch for the bridge.
 */

import type { CanonicalDocument } from './canonical.js';
import { mapCompositionToAppendOperations, type CompositionGap } from './compositionAppend.js';
import type { CompositionPlan } from './compositionPlan.js';
import type { DocumentOperation } from './documentOperations.js';

export const COMPOSITION_OPERATION_BATCH_VERSION = 1 as const;

/** A composition plus the append operations and gaps it maps onto. */
export interface CompositionOperationBatch {
  version: typeof COMPOSITION_OPERATION_BATCH_VERSION;
  /** The generated, filled composition this batch was derived from. */
  composition: CanonicalDocument;
  /** The validated plan behind the composition, when the caller has it. */
  plan?: CompositionPlan;
  /** Existing operation kinds, in document order, ready to be bound to a base revision. */
  operations: DocumentOperation[];
  /** Composed structures the operation vocabulary cannot represent. Never dropped. */
  gaps: CompositionGap[];
}

/**
 * Builds a Composer operation batch from a generated composition. Pure and
 * deterministic: it delegates to `mapCompositionToAppendOperations` and never
 * mutates the composition. Constructing a batch performs no document mutation;
 * the batch stays inert until the workspace binds and applies it.
 */
export function composeOperationBatch(
  composition: CanonicalDocument,
  plan?: CompositionPlan,
): CompositionOperationBatch {
  const { operations, gaps } = mapCompositionToAppendOperations(composition);
  return {
    version: COMPOSITION_OPERATION_BATCH_VERSION,
    composition,
    ...(plan ? { plan } : {}),
    operations,
    gaps,
  };
}
