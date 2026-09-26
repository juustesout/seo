/**
 * Designer proposal -> workspace mutation adapter (R5.5.2).
 *
 * A Designer proposal is a reviewable envelope, not a mutation instruction. This
 * module is the smallest correct adapter between the existing `DesignerProposal`
 * shape and the existing workspace document-operation vocabulary: it answers the
 * only question the unified mutation pipeline needs - can this proposal be
 * applied through `EditorContext.applyDocumentOperations` / `applyImageInsertion`
 * (or the whole-document replacement, for an empty target), and if not, why.
 *
 * It is deliberately pure and dependency-free of React/Tiptap. It reuses the
 * proposal's own fields and never invents a second operation model:
 *
 *   - `proposal.operations` (a `DocumentOperationBatch`) is reused verbatim;
 *   - `proposal.insertion` (an `InsertImageOperation`) is reused verbatim;
 *   - `proposal.acquisition` asks for a confirmed image generation, which is a
 *     future run, not an apply;
 *   - a proposal carrying only `proposal.document` is a whole-document result.
 *     The unified workspace must never silently replace the live document with
 *     it, and there is no established safe diff from a canonical document to
 *     operations, so it stays proposal-only and explicit.
 *
 * Mapping only what is genuinely representable is the point: unsupported output
 * is surfaced as a typed result rather than silently dropped or applied.
 */
import type { DesignerProposal, DocumentOperationBatch, InsertImageOperation } from '@seo/contracts';

/** Why a Designer proposal cannot be applied through the workspace pipeline. */
export type DesignerMutationUnsupportedCode = 'generation_required' | 'canonical_document_only';

/**
 * How a Designer proposal can be applied, or the explicit reason it cannot.
 * `operations` and `insertion` both name the existing editor mutation entry
 * point the bridge will call; neither introduces a new mutation model.
 */
export type DesignerMutationPlan =
  | { kind: 'operations'; batch: DocumentOperationBatch }
  | { kind: 'insertion'; operation: InsertImageOperation }
  | { kind: 'unsupported'; code: DesignerMutationUnsupportedCode; reason: string };

/** User-facing copy for the unsupported forms, kept here so every caller agrees. */
export const DESIGNER_MUTATION_UNSUPPORTED_COPY: Record<DesignerMutationUnsupportedCode, string> = {
  generation_required:
    'This proposal asks the Designer to generate an image. Confirm the generation and run it again to get a proposal that can be applied.',
  canonical_document_only:
    'This proposal is a whole-document result. The workspace can only apply proposals that carry document operations, so it is shown for review only and cannot be applied here.',
};

/**
 * Classifies one proposal against the existing mutation vocabulary. Order is
 * significant: an operation batch is the most specific instruction, an insertion
 * is next, and a bare canonical document is the unsupported fallback.
 */
export function planDesignerMutation(proposal: DesignerProposal): DesignerMutationPlan {
  if (proposal.operations) return { kind: 'operations', batch: proposal.operations };
  if (proposal.insertion) return { kind: 'insertion', operation: proposal.insertion };
  if (proposal.acquisition) {
    return {
      kind: 'unsupported',
      code: 'generation_required',
      reason: DESIGNER_MUTATION_UNSUPPORTED_COPY.generation_required,
    };
  }
  return {
    kind: 'unsupported',
    code: 'canonical_document_only',
    reason: DESIGNER_MUTATION_UNSUPPORTED_COPY.canonical_document_only,
  };
}

/** True when the plan can be handed to the shared workspace mutation pipeline. */
export function isDesignerMutationRepresentable(
  plan: DesignerMutationPlan,
): plan is Extract<DesignerMutationPlan, { kind: 'operations' | 'insertion' }> {
  return plan.kind !== 'unsupported';
}
