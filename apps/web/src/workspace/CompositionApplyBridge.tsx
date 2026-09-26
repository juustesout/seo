/**
 * Workspace document mutation bridge (R5.4.3.2, extended R5.4.3.4 and R5.5.2).
 *
 * A page composed or a Designer proposal generated while no editor is mounted
 * (Composer/Designer modes are isolated, R5.3.3) cannot mutate the document
 * directly. The mutation can only happen through the editor, so the shell stages
 * the output as a `DesignerProposal` handoff and switches to the editor mode;
 * this component, which lives inside `EditorContextProvider`, performs the apply
 * once the editor is ready.
 *
 * It introduces no mutation model of its own: the staged value is the existing
 * `DesignerProposal` envelope, and the apply is one of the existing editor
 * mutation paths, selected by the staged `mode`:
 *   - `replace`    -> `applyExternalDocument` (whole-document replacement of an
 *                     empty target; Composer only)
 *   - `operations` -> `applyDocumentOperations` (an existing operation batch;
 *                     Composer append or a Designer structural proposal)
 *   - `insertion`  -> `applyImageInsertion` (an existing R3.1 insertion; a
 *                     Designer image-insertion proposal)
 *
 * Every path is the same revision-guarded transaction every external change
 * uses, so the resulting change reuses the existing autosave/history machinery.
 * The captured session `boundary` makes a document switch, new document or close
 * between request and apply a no-op instead of a write into the wrong document;
 * `targetDocumentId`, when present, additionally pins the apply to the exact
 * document the proposed change was generated for (two empty documents can share
 * a revision, so the boundary is not the only guard the Designer needs).
 */
import { useEffect, useRef } from 'react';
import {
  DESIGNER_PROPOSAL_VERSION,
  DOCUMENT_OPERATIONS_VERSION,
  type CanonicalDocument,
  type CompositionGap,
  type CompositionOperationBatch,
  type DesignerProposal,
  type DocumentOperation,
} from '@seo/contracts';
import { useEditorContext } from '../components/content/editor/EditorContext';
import { useWorkspaceSessionContext } from './workspaceSession';

/** Which existing editor mutation path a staged proposal is applied through. */
export type PendingMutationMode = 'replace' | 'operations' | 'insertion';

/** Which surface staged the mutation; only affects the result copy. */
export type PendingMutationOrigin = 'composer' | 'designer';

/**
 * A proposal waiting to be applied to the one open document. `proposal` is the
 * existing envelope; `boundary` is the session document boundary the mutation
 * was requested against; `mode` selects the existing editor apply path;
 * `targetDocumentId` pins the apply to the exact document the proposal was
 * generated for; `gaps` records unsupported composed structures the append path
 * could not represent (empty for full replacement and Designer proposals).
 */
export interface PendingComposition {
  proposal: DesignerProposal;
  boundary: string;
  mode: PendingMutationMode;
  origin: PendingMutationOrigin;
  targetDocumentId?: string | null;
  gaps?: CompositionGap[];
}

/** Builds the pending handoff for a whole-document (empty target) replacement. */
export function pendingCompositionOf(
  document: CanonicalDocument,
  baseRevision: string,
  boundary: string,
): PendingComposition {
  return {
    proposal: { version: DESIGNER_PROPOSAL_VERSION, baseRevision, document },
    boundary,
    mode: 'replace',
    origin: 'composer',
  };
}

/**
 * Builds the pending handoff for appending to a non-empty document. It carries
 * the base document too, so the staged value is a complete `DesignerProposal`
 * whose only actionable part is `operations`; unsupported structures ride along
 * as `gaps` for the caller to surface.
 */
export function pendingAppendCompositionOf(
  baseDocument: CanonicalDocument,
  operations: DocumentOperation[],
  baseRevision: string,
  boundary: string,
  gaps: CompositionGap[] = [],
): PendingComposition {
  return {
    proposal: {
      version: DESIGNER_PROPOSAL_VERSION,
      baseRevision,
      document: baseDocument,
      operations: { version: DOCUMENT_OPERATIONS_VERSION, baseRevision, operations },
    },
    boundary,
    mode: 'operations',
    origin: 'composer',
    gaps,
  };
}

/**
 * Stages a Composer operation batch (R5.4.4) for the bridge. The batch carries
 * no document revision by design, so the workspace binds the open document's
 * `baseRevision` here; this is the one place a Composer-level batch becomes a
 * `DesignerProposal` the existing bridge can execute.
 */
export function pendingAppendCompositionFromBatch(
  batch: CompositionOperationBatch,
  baseDocument: CanonicalDocument,
  baseRevision: string,
  boundary: string,
): PendingComposition {
  return pendingAppendCompositionOf(baseDocument, batch.operations, baseRevision, boundary, batch.gaps);
}

/**
 * Stages a representable Designer proposal (R5.5.2) for the bridge. The proposal
 * envelope is passed through intact - including its `review`/`visual` provenance
 * - so the bridge executes its existing `operations` or `insertion`; the
 * caller must have already classified it with `planDesignerMutation` and refused
 * the unsupported forms, which never reach the bridge.
 */
export function pendingDesignerMutation(
  proposal: DesignerProposal,
  mode: Extract<PendingMutationMode, 'operations' | 'insertion'>,
  boundary: string,
  targetDocumentId: string,
): PendingComposition {
  return { proposal, boundary, mode, origin: 'designer', targetDocumentId };
}

/** How a staged mutation resolved. `stale-document` never touched the editor. */
export type CompositionApplyOutcome =
  | { status: 'applied' }
  | { status: 'stale-document' }
  | { status: 'failed' };

export interface CompositionApplyBridgeProps {
  pending: PendingComposition | null;
  /** True once the live editor instance exists; the apply waits for it. */
  ready: boolean;
  onResult: (outcome: CompositionApplyOutcome) => void;
}

export function CompositionApplyBridge({ pending, ready, onResult }: CompositionApplyBridgeProps) {
  const context = useEditorContext();
  const { session } = useWorkspaceSessionContext();
  // Applies each staged mutation at most once, so a context re-render cannot
  // turn a successful apply into a spurious stale-revision failure.
  const handled = useRef<PendingComposition | null>(null);

  useEffect(() => {
    if (!pending || handled.current === pending) return;

    // The document the mutation was requested against is gone; never apply to
    // whatever document the session moved on to.
    if (session.boundary !== pending.boundary) {
      handled.current = pending;
      onResult({ status: 'stale-document' });
      return;
    }

    // A proposal generated for another document must never apply, even when the
    // destination happens to share its revision (two empty documents can).
    if (pending.targetDocumentId != null && session.identity.documentId !== pending.targetDocumentId) {
      handled.current = pending;
      onResult({ status: 'stale-document' });
      return;
    }

    if (!context || !ready || !context.snapshot.ready) return;

    handled.current = pending;
    const { proposal, mode } = pending;
    const applied = applyPending(context, mode, proposal);
    if (applied.ok) onResult({ status: 'applied' });
    else if (applied.reason === 'stale-revision') onResult({ status: 'stale-document' });
    else onResult({ status: 'failed' });
  }, [pending, ready, context, session.boundary, session.identity.documentId, onResult]);

  return null;
}

type ApplyResult = { ok: true } | { ok: false; reason: 'stale-revision' | 'failed' };

/**
 * Dispatches a staged proposal to the matching existing editor mutation path.
 * A mode whose proposal does not actually carry that instruction is a failure,
 * never a silent fallback to whole-document replacement.
 */
function applyPending(
  context: NonNullable<ReturnType<typeof useEditorContext>>,
  mode: PendingMutationMode,
  proposal: DesignerProposal,
): ApplyResult {
  if (mode === 'operations') {
    if (!proposal.operations) return { ok: false, reason: 'failed' };
    const result = context.applyDocumentOperations(proposal.operations, proposal.baseRevision);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason === 'stale-revision' ? 'stale-revision' : 'failed' };
  }
  if (mode === 'insertion') {
    if (!proposal.insertion) return { ok: false, reason: 'failed' };
    const result = context.applyImageInsertion(proposal.insertion, proposal.baseRevision);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason === 'stale-revision' ? 'stale-revision' : 'failed' };
  }
  const result = context.applyExternalDocument({
    canonical: proposal.document,
    expectedRevision: proposal.baseRevision,
    source: 'composer',
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason === 'stale-revision' ? 'stale-revision' : 'failed' };
}
