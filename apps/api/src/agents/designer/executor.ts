/**
 * Designer plan executor (Stage 8E.6, Phase 2).
 *
 * A bounded, synchronous, deterministic executor for a validated `DesignerPlan`.
 * The Designer coordinates specialists; it never writes copy or structure
 * itself. This module owns only the sequential dispatch and the deterministic
 * review - the actual specialist work is injected as typed capabilities
 * (`DesignerExecutorDependencies`), mirroring the Writer run dependency
 * allowlist. No dynamic tool registry, no agent-to-agent calls, no AI call here,
 * no persistence: the executor only produces a final `CanonicalDocument` for the
 * caller to turn into a proposal.
 *
 * Two boundaries are intentionally hard:
 *   - Steps run strictly in plan order (`step[0] -> step[1] -> ...`); a step that
 *     needs a document but runs before one exists fails with a stable
 *     `designer_step_order_invalid` instead of guessing.
 *   - `writer.freeText` is an optional seam. The existing Writer is a durable
 *     LangGraph with a human-approval interrupt, so it cannot be auto-approved
 *     inside a synchronous proposal run; when no capability is wired the step
 *     fails honestly with `writer_free_text_unavailable`. Phase 2 ships no
 *     lightweight replacement Writer.
 *
 * Nothing here mutates `seo_content`; applying a proposal is a separate,
 * explicit human step (see `designerService.apply`).
 */

import type {
  AgentResult,
  CanonicalBlock,
  CanonicalDocument,
  CompositionPlan,
  CompositionSlotMap,
  DesignBrief,
  DesignerPlan,
  DesignerReview,
  DesignerReviewCriterion,
  DesignerReviewIssue,
  DesignerRevisionTarget,
  DesignBriefFormat,
  VisualAssetSelectionRequest,
  VisualDesignOperation,
} from '@seo/contracts';
import {
  canonicalDocumentToEditorDocument,
  evaluateSeo,
  findCompiledSlotBlock,
  isCanonicalStructurePreserved,
  isValidAgentResult,
  isValidCanonicalDoc,
  isValidCompositionSlotMap,
  isValidDesignBrief,
  isValidDesignerPlan,
} from '@seo/contracts';
import { ApiError } from '../../apiErrors.js';

// ---------------------------------------------------------------------------
// Injected specialist capabilities
// ---------------------------------------------------------------------------

/** Input for a `composer.structure` step: build the skeleton for one format. */
export interface DesignerStructureInput {
  projectId: string;
  brief?: DesignBrief;
  format: DesignBriefFormat;
}

/** Composer output: the authoritative plan plus its compiled skeleton. */
export interface DesignerStructureOutput {
  plan: CompositionPlan;
  document: CanonicalDocument;
  slots: CompositionSlotMap;
}

/** Input for a `writer.fillSlots` step: fill the named compiled slots. */
export interface DesignerFillSlotsInput {
  projectId: string;
  brief?: DesignBrief;
  plan: CompositionPlan;
  document: CanonicalDocument;
  slots: CompositionSlotMap;
  /** Slots to fill; empty means every writable slot. */
  slotsToFill: string[];
}

/** Input for a `writer.freeText` step. */
export interface DesignerFreeTextInput {
  projectId: string;
  brief?: DesignBrief;
  instruction: string;
}

/**
 * Input for a `writer.revise` step: the current document plus a bounded,
 * server-side target scope. The capability must resolve the target itself and
 * may never introduce or reorder structure.
 */
export interface DesignerReviseInput {
  projectId: string;
  brief?: DesignBrief;
  instruction: string;
  target: DesignerRevisionTarget;
  document: CanonicalDocument;
}

/**
 * Input for a `visual.apply` step: the current document plus the visual-domain
 * operations to compose. The capability resolves assets through the media
 * infrastructure and returns the composed document with the validated visual
 * proposal attached; it never persists and never invents an asset.
 */
export interface DesignerVisualInput {
  projectId: string;
  brief?: DesignBrief;
  document: CanonicalDocument;
  /** Explicit visual operations, when the plan names them. */
  operations?: VisualDesignOperation[];
  /** Or a bounded asset-selection request the domain resolves itself. */
  selection?: VisualAssetSelectionRequest;
}

/** Typed service calls the Designer may make, one per specialist capability. */
export interface DesignerExecutorDependencies {
  structure(input: DesignerStructureInput): Promise<DesignerStructureOutput>;
  fillSlots(input: DesignerFillSlotsInput): Promise<AgentResult>;
  /** Bounded, structure-preserving revision of the current document. */
  revise?(input: DesignerReviseInput): Promise<AgentResult>;
  /** Visual domain: asset selection and bounded presentation on the document. */
  visual?(input: DesignerVisualInput): Promise<AgentResult>;
  /** Optional Writer free-text seam; absent means the step is unavailable. */
  freeText?(input: DesignerFreeTextInput): Promise<AgentResult>;
}

/** Request for one Designer execution. */
export interface DesignerExecutionInput {
  projectId: string;
  /** The already-built plan (Phase 2 has no AI intent interpreter). */
  plan: DesignerPlan;
  /** Brief override; defaults to the brief echoed on the plan. */
  brief?: DesignBrief;
  /**
   * Existing document the plan starts from, when the run targets stored content.
   * Seeded as both the working document and the structure reference so a
   * `writer.revise` step can edit it without a `composer.structure` step.
   */
  baseDocument?: CanonicalDocument;
}

/** The executor's complete output: the final document plus what happened. */
export interface DesignerExecutionResult {
  document: CanonicalDocument;
  plan: DesignerPlan;
  results: AgentResult[];
  review: DesignerReview | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A step required a prior document but none existed yet. */
function stepOrderError(kind: string, index: number): ApiError {
  return new ApiError(
    422,
    'designer_step_order_invalid',
    `Designer step ${index} (${kind}) requires a document produced by an earlier step.`,
  );
}

/** A specialist capability returned a value violating its contract. */
function stepResultInvalid(kind: string, index: number): ApiError {
  return new ApiError(
    422,
    'designer_step_result_invalid',
    `Designer step ${index} (${kind}) returned a result that does not satisfy the agent result contract.`,
  );
}

// ---------------------------------------------------------------------------
// Deterministic review
// ---------------------------------------------------------------------------

export interface DesignerReviewRunInput {
  document: CanonicalDocument;
  /** Skeleton the document must still match structurally, when known. */
  skeleton: CanonicalDocument | null;
  /** Compiled slots, when a structure step produced them. */
  slots: CompositionSlotMap | null;
  filled: readonly string[];
  unfilled: readonly string[];
  criteria: readonly DesignerReviewCriterion[];
  brief?: DesignBrief;
  /** Index of the review step, echoed on every issue. */
  step: number;
}

function slotIsEmpty(block: CanonicalBlock | undefined, type: string): boolean {
  if (!block) return true;
  if (type === 'list') return !block.children || block.children.length === 0;
  return !block.content || block.content.length === 0;
}

/**
 * Runs exactly the requested deterministic criteria and returns an honest
 * `DesignerReview`. No AI, no network: `document_valid` uses the canonical
 * guard, `structure_preserved` the canonical structure signature,
 * `slots_filled` the compiled slot map and `seo` the canonical evaluator.
 */
export function runDesignerReview(input: DesignerReviewRunInput): DesignerReview {
  const errors: DesignerReviewIssue[] = [];
  const warnings: DesignerReviewIssue[] = [];
  let score: number | undefined;

  for (const criterion of input.criteria) {
    switch (criterion) {
      case 'document_valid': {
        if (!isValidCanonicalDoc(input.document)) {
          errors.push({ code: 'document_invalid', message: 'The final document is not a valid canonical document.', step: input.step });
        }
        break;
      }
      case 'structure_preserved': {
        if (!input.skeleton) {
          warnings.push({
            code: 'structure_reference_missing',
            message: 'No composer skeleton is known, so structure preservation could not be verified.',
            step: input.step,
          });
          break;
        }
        if (!isCanonicalStructurePreserved(input.skeleton, input.document)) {
          errors.push({
            code: 'structure_changed',
            message: 'The final document changed the composition structure.',
            step: input.step,
          });
        }
        break;
      }
      case 'slots_filled': {
        if (!input.slots) {
          warnings.push({
            code: 'slots_reference_missing',
            message: 'No compiled slot map is known, so slot coverage could not be verified.',
            step: input.step,
          });
          break;
        }
        const compiled = { document: input.document, slots: input.slots };
        const bySlot = new Map(input.slots.slots.map((ref) => [ref.slot, ref]));
        const expected = new Set<string>([...input.filled, ...input.unfilled]);
        for (const slot of expected) {
          const ref = bySlot.get(slot);
          if (!ref) continue;
          const block = findCompiledSlotBlock(compiled, slot);
          if (!slotIsEmpty(block, ref.type)) continue;
          if (input.unfilled.includes(slot)) {
            warnings.push({
              code: 'slot_unfilled',
              message: `Writable slot "${slot}" was reported unfilled.`,
              step: input.step,
            });
          } else {
            errors.push({ code: 'slot_empty', message: `Writable slot "${slot}" is empty.`, step: input.step });
          }
        }
        break;
      }
      case 'seo': {
        try {
          const editorDoc = canonicalDocumentToEditorDocument(input.document);
          const seo = evaluateSeo({ doc: editorDoc, meta: { title: input.brief?.topic ?? '' } });
          score = seo.score;
        } catch {
          errors.push({ code: 'seo_evaluation_failed', message: 'The canonical SEO evaluation failed.', step: input.step });
        }
        break;
      }
    }
  }

  const review: DesignerReview = { ok: errors.length === 0, errors, warnings };
  if (score !== undefined) review.score = score;
  return review;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecutionState {
  document: CanonicalDocument | null;
  skeleton: CanonicalDocument | null;
  plan: CompositionPlan | null;
  slots: CompositionSlotMap | null;
  results: AgentResult[];
  review: DesignerReview | null;
  filled: string[];
  unfilled: string[];
}

/**
 * Executes a validated `DesignerPlan` in order and returns the final canonical
 * document plus the specialist results and the last deterministic review.
 * Throws a typed `ApiError` for a malformed plan, a step out of order, an
 * unavailable capability or a specialist result that violates its contract -
 * never a partial or fabricated document.
 */
export async function executeDesignerPlan(
  input: DesignerExecutionInput,
  deps: DesignerExecutorDependencies,
): Promise<DesignerExecutionResult> {
  if (!isValidDesignerPlan(input.plan)) {
    throw ApiError.badRequest('Invalid designer plan');
  }
  if (input.brief !== undefined && !isValidDesignBrief(input.brief)) {
    throw ApiError.badRequest('Invalid design brief');
  }
  if (input.baseDocument !== undefined && !isValidCanonicalDoc(input.baseDocument)) {
    throw ApiError.badRequest('Invalid base document');
  }
  const brief = input.brief ?? input.plan.brief;

  const state: ExecutionState = {
    document: input.baseDocument ?? null,
    skeleton: input.baseDocument ?? null,
    plan: null,
    slots: null,
    results: [],
    review: null,
    filled: [],
    unfilled: [],
  };

  for (const [index, step] of input.plan.steps.entries()) {
    switch (step.kind) {
      case 'composer.structure': {
        const output = await deps.structure({ projectId: input.projectId, brief, format: step.task.format });
        if (!isValidCanonicalDoc(output.document) || !isValidCompositionSlotMap(output.slots)) {
          throw stepResultInvalid(step.kind, index);
        }
        state.document = output.document;
        state.skeleton = output.document;
        state.plan = output.plan;
        state.slots = output.slots;
        state.results.push({ role: 'composer', document: output.document, slots: output.slots });
        break;
      }
      case 'writer.fillSlots': {
        if (!state.document || !state.plan || !state.slots) throw stepOrderError(step.kind, index);
        const result = await deps.fillSlots({
          projectId: input.projectId,
          brief,
          plan: state.plan,
          document: state.document,
          slots: state.slots,
          slotsToFill: step.task.slots,
        });
        if (!isValidAgentResult(result) || result.role !== 'writer') throw stepResultInvalid(step.kind, index);
        state.document = result.document;
        state.filled = result.filled ?? [];
        state.unfilled = result.unfilled ?? [];
        state.results.push(result);
        break;
      }
      case 'writer.revise': {
        if (!state.document) throw stepOrderError(step.kind, index);
        if (!deps.revise) {
          throw new ApiError(
            503,
            'writer_revise_unavailable',
            'The writer.revise capability is not available; no revision Writer is wired for this step.',
          );
        }
        const result = await deps.revise({
          projectId: input.projectId,
          brief,
          instruction: step.task.instruction,
          target: step.task.target,
          document: state.document,
        });
        if (!isValidAgentResult(result) || result.role !== 'writer') throw stepResultInvalid(step.kind, index);
        state.document = result.document;
        state.results.push(result);
        break;
      }
      case 'visual.apply': {
        if (!state.document) throw stepOrderError(step.kind, index);
        if (!deps.visual) {
          throw new ApiError(
            503,
            'visual_design_unavailable',
            'The visual.apply capability is not available; no visual design capability is wired for this step.',
          );
        }
        const result = await deps.visual({
          projectId: input.projectId,
          brief,
          document: state.document,
          ...(step.task.operations !== undefined ? { operations: step.task.operations } : {}),
          ...(step.task.select !== undefined ? { selection: step.task.select } : {}),
        });
        // The capability returns a document plus its validated visual proposal;
        // a malformed result never becomes the working document.
        if (!isValidAgentResult(result) || result.role !== 'visual') throw stepResultInvalid(step.kind, index);
        state.document = result.document;
        state.results.push(result);
        break;
      }
      case 'writer.freeText': {
        if (!deps.freeText) {
          throw new ApiError(
            503,
            'writer_free_text_unavailable',
            'The writer.freeText capability is not available; no Writer implementation is wired for this step.',
          );
        }
        const result = await deps.freeText({ projectId: input.projectId, brief, instruction: step.task.instruction });
        if (!isValidAgentResult(result) || result.role !== 'writer') throw stepResultInvalid(step.kind, index);
        state.document = result.document;
        state.results.push(result);
        break;
      }
      case 'designer.review': {
        if (!state.document) throw stepOrderError(step.kind, index);
        state.review = runDesignerReview({
          document: state.document,
          skeleton: state.skeleton,
          slots: state.slots,
          filled: state.filled,
          unfilled: state.unfilled,
          criteria: step.criteria,
          brief,
          step: index,
        });
        break;
      }
    }
  }

  if (!state.document) {
    throw new ApiError(422, 'designer_step_order_invalid', 'The designer plan produced no document.');
  }

  return { document: state.document, plan: input.plan, results: state.results, review: state.review };
}
