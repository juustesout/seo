/**
 * Designer application service (Stage 8E.6, Phase 2).
 *
 * The single orchestration seam for the Designer agent. It owns the production
 * wiring the pure executor deliberately does not know about:
 *
 *   - `composer.structure` goes through the existing `CompositionPlannerService`
 *     + deterministic `compileComposition` (structure only, no copy);
 *   - `writer.fillSlots` goes through the existing `createAiCompositionWriter`
 *     boundary + `applyCompositionSlotFills` (the Writer capability, unchanged);
 *   - `writer.freeText` is intentionally NOT wired: the existing Writer is a
 *     durable LangGraph with a human-approval interrupt and must not be
 *     auto-approved inside a synchronous proposal run, so the step fails
 *     honestly with `writer_free_text_unavailable` until a later phase adapts it;
 *   - `designer.review` is the executor's deterministic check.
 *
 * `execute` never persists: it returns a `DesignerProposal` envelope guarded by a
 * `baseRevision`. `apply` is the explicit human approval step: it re-reads the
 * current content, compares revisions and only then writes through the existing
 * `ContentService` (the single persist choke point). A revision mismatch is a
 * `stale_proposal` conflict with zero mutation.
 *
 * Phase 3.1 adds a second, opt-in entry point (`executeIntent`) that runs the
 * same `execute` path behind a replaceable `DesignerPlanner`: intent -> plan ->
 * execute. The planner is injected (defaulting to the deterministic Phase 3.1
 * planner), so the service never couples to a concrete planner implementation.
 * The existing explicit-plan path is unchanged.
 */

import type { AgentResult, DesignBrief, DesignerIntent, DesignerPlan, DesignerPlanner, DesignerProposal } from '@seo/contracts';
import {
  DESIGNER_PROPOSAL_VERSION,
  applyCompositionSlotFills,
  boundCompositionPlannerBrief,
  canonicalDocumentToEditorDocument,
  compileComposition,
  contentRevisionOf,
  isWritableCompositionSlot,
  isValidDesignBrief,
  isValidDesignerPlan,
  isValidDesignerProposal,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { createAiCompositionWriter } from '../agents/composition/writer.js';
import {
  executeDesignerPlan,
  type DesignerExecutorDependencies,
} from '../agents/designer/executor.js';
import { DeterministicDesignerPlanner, runDesignerPlanner } from '../agents/designer/planner.js';
import { AIService } from './aiService.js';
import { compositionWriterError } from './compositionService.js';
import { CompositionPlannerService } from './compositionPlannerService.js';
import { ContentService } from './contentService.js';
import { getCosmosContext } from './cosmosService.js';

/** Request for one Designer execution. Never persists. */
export interface DesignerExecuteInput {
  plan: DesignerPlan;
  brief?: DesignBrief;
  /** Optional content the proposal is generated against; resolves baseRevision. */
  contentId?: string;
  /** Explicit base revision when no contentId is given. */
  baseRevision?: string;
}

/** Service options: the planner is an injected, replaceable boundary. */
export interface DesignerServiceOptions {
  /** Planning boundary; defaults to the deterministic Phase 3.1 planner. */
  planner?: DesignerPlanner;
}

/** Optional invocation state for intent execution that is not part of the intent. */
export interface DesignerIntentOptions {
  /** Explicit base revision when the intent does not name a contentId. */
  baseRevision?: string;
}

/** Builds a bounded, single-string brief for the existing Composer/Writer. */
function briefToText(brief: DesignBrief | undefined): string {
  if (!brief) return 'Design this document from the supplied plan.';
  const parts = [brief.goal];
  if (brief.topic) parts.push(`Topic: ${brief.topic}`);
  if (brief.audience) parts.push(`Audience: ${brief.audience}`);
  if (brief.constraints && brief.constraints.length > 0) parts.push(`Constraints: ${brief.constraints.join('; ')}`);
  return boundCompositionPlannerBrief(parts.join('\n'));
}

export class DesignerService {
  private readonly planner: DesignerPlanner;

  constructor(
    private readonly container: ServiceContainer,
    options: DesignerServiceOptions = {},
  ) {
    this.planner = options.planner ?? new DeterministicDesignerPlanner();
  }

  /** Production capability wiring, one method per specialist step kind. */
  private dependencies(projectId: string, cosmosText: string): DesignerExecutorDependencies {
    const ai = new AIService(this.container);

    return {
      structure: async ({ brief, format }) => {
        const plan = await new CompositionPlannerService(this.container).plan(
          projectId,
          { brief: briefToText(brief), format },
          { cosmosText },
        );
        const compiled = compileComposition(plan);
        return { plan, document: compiled.document, slots: compiled.slots };
      },
      fillSlots: async ({ brief, plan, document, slots, slotsToFill }) => {
        const bySlot = new Map(slots.slots.map((ref) => [ref.slot, ref]));
        let requested: string[];
        if (slotsToFill.length > 0) {
          for (const slot of slotsToFill) {
            const ref = bySlot.get(slot);
            if (!ref) throw ApiError.badRequest(`Unknown slot "${slot}" in writer.fillSlots step`);
            if (!isWritableCompositionSlot(ref)) throw ApiError.badRequest(`Slot "${slot}" is not writable`);
          }
          requested = slotsToFill;
        } else {
          requested = slots.slots.filter(isWritableCompositionSlot).map((ref) => ref.slot);
        }
        const selected = requested.map((slot) => bySlot.get(slot)!);

        const writer = createAiCompositionWriter((id) => ai.resolve(id));
        const outcome = await writer.fill({
          projectId,
          brief: briefToText(brief),
          plan,
          slots: selected,
          cosmosText,
        });
        if (!outcome.ok) throw compositionWriterError(outcome);

        const applied = applyCompositionSlotFills({ document, slots: { slots: selected } }, outcome.fills);
        const result: AgentResult = {
          role: 'writer',
          document: applied.document,
          filled: applied.filled,
          unfilled: applied.unfilled,
        };
        return result;
      },
    };
  }

  /**
   * Runs one Designer plan and returns a reviewable proposal. Validates the
   * plan and brief at the boundary, resolves the base revision (from the bound
   * content when a contentId is given, else an explicit token) and never writes
   * seo_content. Failures are honest typed `ApiError`s.
   */
  async execute(projectId: string, input: DesignerExecuteInput): Promise<DesignerProposal> {
    if (!isValidDesignerPlan(input.plan)) throw ApiError.badRequest('Invalid designer plan');
    if (input.brief !== undefined && !isValidDesignBrief(input.brief)) {
      throw ApiError.badRequest('Invalid design brief');
    }

    const baseRevision = await this.resolveBaseRevision(projectId, input);
    const cosmosText = (await getCosmosContext(this.container, projectId)).text;
    const execution = await executeDesignerPlan(
      { projectId, plan: input.plan, ...(input.brief !== undefined ? { brief: input.brief } : {}) },
      this.dependencies(projectId, cosmosText),
    );

    const proposal: DesignerProposal = {
      version: DESIGNER_PROPOSAL_VERSION,
      baseRevision,
      document: execution.document,
      plan: execution.plan,
    };
    if (execution.review) proposal.review = execution.review;

    if (!isValidDesignerProposal(proposal)) {
      throw new ApiError(500, 'designer_proposal_invalid', 'The Designer produced an invalid proposal.');
    }
    return proposal;
  }

  /**
   * Runs the planner then the Phase 2 executor: INTENT -> PLAN -> EXECUTE. The
   * intent is validated and the planner output re-validated on the boundary
   * (`runDesignerPlanner`), the plan is then executed through the exact same
   * `execute` path as an explicit plan, and the result is still only a proposal
   * (never an apply). The planner is the injected `DesignerPlanner`, so this
   * never couples to the deterministic implementation.
   */
  async executeIntent(
    projectId: string,
    intent: DesignerIntent,
    options: DesignerIntentOptions = {},
  ): Promise<DesignerProposal> {
    if (intent.projectId !== projectId) {
      throw new ApiError(400, 'invalid_designer_intent', 'The Designer intent does not belong to this project.');
    }
    const plan = await runDesignerPlanner(this.planner, intent);
    return this.execute(projectId, {
      plan,
      ...(intent.brief !== undefined ? { brief: intent.brief } : {}),
      ...(intent.contentId !== undefined ? { contentId: intent.contentId } : {}),
      ...(options.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
    });
  }

  /** Resolves the revision guard: bound content wins, then an explicit token. */
  private async resolveBaseRevision(projectId: string, input: DesignerExecuteInput): Promise<string> {
    if (input.contentId) {
      const row = await new ContentService(this.container.sb).get(projectId, input.contentId);
      return contentRevisionOf(row.content_json);
    }
    if (input.baseRevision) return input.baseRevision;
    throw ApiError.badRequest('A contentId or baseRevision is required to build a Designer proposal');
  }

  /**
   * Applies an explicitly approved proposal. Re-reads the current content and
   * refuses with `stale_proposal` (409) when its revision no longer matches the
   * proposal's `baseRevision` - before any mutation. On a match the canonical
   * document is converted to the editor document and saved through the existing
   * `ContentService.write` choke point.
   */
  async apply(projectId: string, contentId: string, rawProposal: unknown, userId: string) {
    if (!isValidDesignerProposal(rawProposal)) throw ApiError.badRequest('Invalid designer proposal');
    const proposal = rawProposal;

    const content = new ContentService(this.container.sb);
    const current = await content.get(projectId, contentId);
    const currentRevision = contentRevisionOf(current.content_json);
    if (currentRevision !== proposal.baseRevision) {
      throw new ApiError(409, 'stale_proposal', 'The content changed since this proposal was generated; generate it again.', {
        expected: proposal.baseRevision,
        actual: currentRevision,
      });
    }

    const editorDocument = canonicalDocumentToEditorDocument(proposal.document);
    return content.update(projectId, userId, contentId, { contentJson: editorDocument });
  }
}
