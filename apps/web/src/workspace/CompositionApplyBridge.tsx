/**
 * Composer -> open document apply bridge (R5.4.3.2).
 *
 * A composed page is generated in Composer mode, where no editor infrastructure
 * is mounted (R5.3.3 isolation). The whole-document replacement itself can only
 * happen through the single editor mutation path
 * (`EditorContext.applyExternalDocument`), so the shell stages the composed
 * document as a handoff and switches to the editor mode; this component, which
 * lives inside `EditorContextProvider`, performs the apply once the editor is
 * ready.
 *
 * It introduces no mutation model of its own: the staged value is the existing
 * `DesignerProposal` envelope (`document` + `baseRevision`), and the apply is the
 * same revision-guarded `setContent` transaction every external document uses.
 * The captured session `boundary` makes a document switch, new document or close
 * between request and apply a no-op instead of a write into the wrong document.
 */
import { useEffect, useRef } from 'react';
import { DESIGNER_PROPOSAL_VERSION, type CanonicalDocument, type DesignerProposal } from '@seo/contracts';
import { useEditorContext } from '../components/content/editor/EditorContext';
import { useWorkspaceSessionContext } from './workspaceSession';

/**
 * A composed page waiting to be applied to the one open document. `proposal` is
 * the existing whole-document suggestion envelope; `boundary` is the session
 * document boundary the composition was requested against.
 */
export interface PendingComposition {
  proposal: DesignerProposal;
  boundary: string;
}

/** Builds the pending handoff from a composed document and its base revision. */
export function pendingCompositionOf(
  document: CanonicalDocument,
  baseRevision: string,
  boundary: string,
): PendingComposition {
  return { proposal: { version: DESIGNER_PROPOSAL_VERSION, baseRevision, document }, boundary };
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
    const result = context.applyExternalDocument({
      canonical: pending.proposal.document,
      expectedRevision: pending.proposal.baseRevision,
      source: 'composer',
    });
    if (result.ok) onResult({ status: 'applied' });
    else if (result.reason === 'stale-revision') onResult({ status: 'stale-document' });
    else onResult({ status: 'failed' });
  }, [pending, ready, context, session.boundary, onResult]);

  return null;
}
