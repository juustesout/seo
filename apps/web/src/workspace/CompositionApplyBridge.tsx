/**
 * Composer -> open document apply bridge (R5.4.3.2, extended in R5.4.3.4).
 *
 * A composed page is generated in Composer mode, where no editor infrastructure
 * is mounted (R5.3.3 isolation). The mutation itself can only happen through the
 * editor, so the shell stages the composed output as a `DesignerProposal` handoff
 * and switches to the editor mode; this component, which lives inside
 * `EditorContextProvider`, performs the apply once the editor is ready.
 *
 * Two proposal forms are supported, on the two existing editor mutation paths:
 *   - `proposal.document` only      -> `applyExternalDocument` (empty document)
 *   - `proposal.operations` present -> `applyDocumentOperations` (append)
 *
 * It introduces no mutation model of its own: the staged value is the existing
 * `DesignerProposal` envelope, and the apply is the same revision-guarded
 * transaction every external change uses. The captured session `boundary` makes a
 * document switch, new document or close between request and apply a no-op
 * instead of a write into the wrong document.
 */
import { useEffect, useRef } from 'react';
import {
  DESIGNER_PROPOSAL_VERSION,
  DOCUMENT_OPERATIONS_VERSION,
  type CanonicalDocument,
  type CompositionGap,
  type DesignerProposal,
  type DocumentOperation,
} from '@seo/contracts';
import { useEditorContext } from '../components/content/editor/EditorContext';
import { useWorkspaceSessionContext } from './workspaceSession';

/**
 * A composed page waiting to be applied to the one open document. `proposal` is
 * the existing envelope; `boundary` is the session document boundary the
 * composition was requested against. `gaps` records unsupported composed
 * structures the append path could not represent (empty for full replacement).
 */
export interface PendingComposition {
  proposal: DesignerProposal;
  boundary: string;
  gaps?: CompositionGap[];
}

/** Builds the pending handoff for a whole-document (empty target) replacement. */
export function pendingCompositionOf(
  document: CanonicalDocument,
  baseRevision: string,
  boundary: string,
): PendingComposition {
  return { proposal: { version: DESIGNER_PROPOSAL_VERSION, baseRevision, document }, boundary };
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
    gaps,
  };
}

/** How a staged composition resolved. `stale-document` never touched the editor. */
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
  // Applies each staged composition at most once, so a context re-render cannot
  // turn a successful replacement into a spurious stale-revision failure.
  const handled = useRef<PendingComposition | null>(null);

  useEffect(() => {
    if (!pending || handled.current === pending) return;

    // The document the composition was requested against is gone; never apply
    // to whatever document the session moved on to.
    if (session.boundary !== pending.boundary) {
      handled.current = pending;
      onResult({ status: 'stale-document' });
      return;
    }

    if (!context || !ready || !context.snapshot.ready) return;

    handled.current = pending;
    const { proposal } = pending;
    const result = proposal.operations
      ? context.applyDocumentOperations(proposal.operations, proposal.baseRevision)
      : context.applyExternalDocument({
          canonical: proposal.document,
          expectedRevision: proposal.baseRevision,
          source: 'composer',
        });
    if (result.ok) onResult({ status: 'applied' });
    else if (result.reason === 'stale-revision') onResult({ status: 'stale-document' });
    else onResult({ status: 'failed' });
  }, [pending, ready, context, session.boundary, onResult]);

  return null;
}
