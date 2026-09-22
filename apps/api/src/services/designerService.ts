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

import type {
  AgentResult,
  CanonicalDocument,
  DesignBrief,
  DesignerIntent,
  DesignerPlan,
  DesignerPlanner,
  DesignerProposal,
  VisualAssetCandidate,
  VisualAssetRef,
  VisualDesignProposal,
} from '@seo/contracts';
import {
  DESIGNER_PROPOSAL_VERSION,
  DesignerRevisionError,
  VISUAL_DESIGN_PROPOSAL_KIND,
  VISUAL_DESIGN_PROPOSAL_VERSION,
  VisualDesignError,
  applyCompositionSlotFills,
  applyDesignerRevision,
  applyVisualDesignProposal,
  boundCompositionPlannerBrief,
  canonicalDocumentToEditorDocument,
  compileComposition,
  contentRevisionOf,
  editorDocumentToCanonical,
  isWritableCompositionSlot,
  isValidDesignBrief,
  isValidDesignerPlan,
  isValidDesignerProposal,
  resolveDesignerRevisionTargets,
  selectVisualAssets,
  visualDesignProposalFromSelections,
  withDesignSystemRef,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { SupabaseStorageStore } from '../infra/mediaStorage.js';
import { createAiCompositionWriter } from '../agents/composition/writer.js';
import { createAiDesignerRevisionWriter, type DesignerRevisionWriterOutcome } from '../agents/designer/revisionWriter.js';
import {
  executeDesignerPlan,
  type DesignerExecutorDependencies,
} from '../agents/designer/executor.js';
import { DeterministicDesignerPlanner, LlmDesignerPlanner, runDesignerPlanner } from '../agents/designer/planner.js';
import { AIService } from './aiService.js';
import { compositionWriterError } from './compositionService.js';
import { CompositionPlannerService } from './compositionPlannerService.js';
import { ContentService } from './contentService.js';
import { DesignerPlannerContextService } from './designerPlannerContextService.js';
import { ImageInsertionService, imageInsertionContextOf } from './imageInsertionService.js';
import { MediaService } from './mediaService.js';
import { getCosmosContext } from './cosmosService.js';

/** Request for one Designer execution. Never persists. */
export interface DesignerExecuteInput {
  plan: DesignerPlan;
  brief?: DesignBrief;
  /** Optional content the proposal is generated against; resolves baseRevision. */
  contentId?: string;
  /** Explicit base revision when no contentId is given. */
  baseRevision?: string;
  /**
   * Explicit existing document to start the plan from. Defaults to the canonical
   * form of the content named by `contentId`, which is how a `writer.revise`
   * step edits stored content.
   */
  baseDocument?: CanonicalDocument;
}

/** Service options: the planner is an injected, replaceable boundary. */
export interface DesignerServiceOptions {
  /** Planning boundary; defaults to the deterministic Phase 3.1 planner. */
  planner?: DesignerPlanner;
  /** When true and no `planner` is injected, use the LLM planner (Phase 3.2). */
  llmPlanner?: boolean;
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

/** Maps a revision Writer failure onto the shared wire error vocabulary. */
function designerRevisionWriterError(outcome: Extract<DesignerRevisionWriterOutcome, { ok: false }>): ApiError {
  switch (outcome.code) {
    case 'not_configured':
      return ApiError.notConfigured(outcome.note);
    case 'ai_error':
      return new ApiError(502, 'designer_revision_ai_error', outcome.note);
    case 'invalid_output':
      return new ApiError(422, 'designer_revision_invalid_output', outcome.note);
    case 'invalid_target':
      return new ApiError(422, 'designer_revision_invalid_target', outcome.note);
  }
}

/** Wraps a pure revision contract failure as a typed 422 (never a 500). */
function mapDesignerRevisionError(err: unknown): never {
  if (err instanceof DesignerRevisionError) {
    throw new ApiError(422, 'designer_revision_invalid_target', err.message);
  }
  throw err;
}

/**
 * Maps a visual contract failure onto an honest wire error. A duplicate
 * operation is a genuine conflict (409); every other rejection is a bounded
 * 422. Never a 500 and never a silent no-op.
 */
function mapVisualDesignError(err: unknown): never {
  if (err instanceof VisualDesignError) {
    const status = err.code === 'duplicate_operation' ? 409 : 422;
    throw new ApiError(status, `visual_design_${err.code}`, err.message);
  }
  throw err;
}

/**
 * Builds the production LLM planner from the container: the bounded context
 * loader reads through the existing content/Cosmos services and the AI resolver
 * reuses `AIService`. Kept in the service layer so the planner itself stays
 * container-free and unit-testable.
 */
export function createLlmDesignerPlanner(container: ServiceContainer): LlmDesignerPlanner {
  const ai = new AIService(container);
  const context = new DesignerPlannerContextService(container);
  return new LlmDesignerPlanner({
    loadContext: (intent) => context.load(intent),
    resolveAi: async (projectId) => {
      const resolved = await ai.resolve(projectId);
      return { provider: resolved.provider, configured: resolved.configured && resolved.provider.isConfigured() };
    },
  });
}

export class DesignerService {
  private readonly planner: DesignerPlanner;

  constructor(
    private readonly container: ServiceContainer,
    options: DesignerServiceOptions = {},
  ) {
    this.planner =
      options.planner ?? (options.llmPlanner ? createLlmDesignerPlanner(container) : new DeterministicDesignerPlanner());
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
      revise: async ({ brief, instruction, target, document }) => {
        let targets;
        try {
          targets = resolveDesignerRevisionTargets(document, target);
        } catch (err) {
          return mapDesignerRevisionError(err);
        }

        const writer = createAiDesignerRevisionWriter((id) => ai.resolve(id));
        const outcome = await writer.revise({
          projectId,
          brief: briefToText(brief),
          instruction,
          targets,
          cosmosText,
        });
        if (!outcome.ok) throw designerRevisionWriterError(outcome);

        try {
          const applied = applyDesignerRevision(document, targets, outcome.fills);
          return { role: 'writer', document: applied.document } satisfies AgentResult;
        } catch (err) {
          return mapDesignerRevisionError(err);
        }
      },
      visual: async ({ document, operations, selection }) => {
        // Resolve the project's media library once. Only metadata is read here;
        // bytes never touch the proposal, the document or the plan.
        const media = await new MediaService(this.container.sb, new SupabaseStorageStore(this.container.sb)).list(
          projectId,
        );

        let proposal: VisualDesignProposal;
        if (selection) {
          const candidates: VisualAssetCandidate[] = media.map((item) => ({
            mediaId: item.id,
            filename: item.filename,
            alt: item.alt_text,
            caption: item.caption,
            mimeType: item.mime_type,
            ...(item.width !== null ? { width: item.width } : {}),
            ...(item.height !== null ? { height: item.height } : {}),
            usageCount: item.usage_count,
          }));
          let result;
          try {
            result = selectVisualAssets(document, candidates, selection);
          } catch (err) {
            return mapVisualDesignError(err);
          }
          // An explicit target list is a promise: every named target must
          // resolve, and a request that matches nothing is an honest failure -
          // never an arbitrary fallback image.
          if (result.selections.length === 0 || (selection.targets !== undefined && result.unmatched.length > 0)) {
            throw new ApiError(
              422,
              'visual_no_suitable_asset',
              'No existing project asset matches the requested visual targets.',
              { unmatched: result.unmatched },
            );
          }
          // Keep the selection rationale and the targets it could not fill so
          // the proposal explains *why* it chose each asset (provenance only).
          try {
            proposal = visualDesignProposalFromSelections(result.selections, undefined, result.unmatched);
          } catch (err) {
            return mapVisualDesignError(err);
          }
        } else {
          proposal = {
            kind: VISUAL_DESIGN_PROPOSAL_KIND,
            version: VISUAL_DESIGN_PROPOSAL_VERSION,
            operations: operations ?? [],
          };
        }

        // Resolve only the referenced assets from the project media library
        // (metadata only; bytes never touch the proposal or the document).
        const wanted = new Set(
          proposal.operations.flatMap((op) => (op.op === 'select_asset' ? [op.mediaId] : [])),
        );
        const assets: VisualAssetRef[] = media
          .filter((item) => wanted.has(item.id))
          .map((item) => ({
            mediaId: item.id,
            url: item.url,
            alt: item.alt_text,
            caption: item.caption,
            ...(item.width !== null ? { width: item.width } : {}),
            ...(item.height !== null ? { height: item.height } : {}),
          }));

        try {
          const composed = applyVisualDesignProposal(document, proposal, assets);
          return { role: 'visual', document: composed.document, visual: proposal } satisfies AgentResult;
        } catch (err) {
          return mapVisualDesignError(err);
        }
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

    const content = input.contentId
      ? await new ContentService(this.container.sb).get(projectId, input.contentId)
      : null;
    const baseRevision = content ? contentRevisionOf(content.content_json) : input.baseRevision;
    if (!baseRevision) {
      throw ApiError.badRequest('A contentId or baseRevision is required to build a Designer proposal');
    }
    const baseDocument = input.baseDocument ?? (content ? editorDocumentToCanonical(content.content_json) : undefined);

    const cosmos = await getCosmosContext(this.container, projectId);
    const cosmosText = cosmos.text;
    const execution = await executeDesignerPlan(
      {
        projectId,
        plan: input.plan,
        ...(input.brief !== undefined ? { brief: input.brief } : {}),
        ...(baseDocument !== undefined ? { baseDocument } : {}),
      },
      this.dependencies(projectId, cosmosText),
    );

    // Carry the applicable design-system identity on the proposal so a Designer
    // result renders against the same token set it was built for. An explicit
    // base document wins; otherwise the project's Cosmos identity applies.
    const designSystemRef =
      execution.document.meta?.designSystem ?? input.baseDocument?.meta?.designSystem ?? cosmos.designSystemRef;
    const proposal: DesignerProposal = {
      version: DESIGNER_PROPOSAL_VERSION,
      baseRevision,
      document: withDesignSystemRef(execution.document, designSystemRef),
      plan: execution.plan,
    };
    if (execution.review) proposal.review = execution.review;
    // Carry the visual domain's provenance (rationale and unmatched targets)
    // when the plan used it. It is explanation only: `document` stays the source
    // of truth and `apply` never depends on it.
    const visualResult = [...execution.results].reverse().find((result) => result.role === 'visual' && result.visual);
    if (visualResult?.visual) proposal.visual = visualResult.visual;

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
    const insertionContext = imageInsertionContextOf(intent);
    if (insertionContext) {
      return new ImageInsertionService(this.container).buildProposal(projectId, intent, insertionContext);
    }
    const plan = await runDesignerPlanner(this.planner, intent);
    return this.execute(projectId, {
      plan,
      ...(intent.brief !== undefined ? { brief: intent.brief } : {}),
      ...(intent.contentId !== undefined ? { contentId: intent.contentId } : {}),
      ...(options.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
    });
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

    if (proposal.insertion) {
      throw new ApiError(
        422,
        'designer_insertion_requires_editor',
        'This proposal inserts an image through the editor and cannot be applied directly.',
      );
    }
    if (proposal.acquisition) {
      throw new ApiError(
        422,
        'designer_acquisition_requires_confirmation',
        'This proposal asks for a confirmed image generation and cannot be applied directly.',
      );
    }

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
