/**
 * Composition service (Stage 8B).
 *
 * The single orchestration point of the full chain:
 *
 *   brief -> CompositionPlan (planner) -> CanonicalDocument skeleton (compiler)
 *         -> slot copy (writer) -> filled CanonicalDocument
 *
 * It reuses the existing planner service, deterministic compiler and the AI
 * writer boundary; it owns only the production wiring and honest failure
 * mapping. Planning and writing are two AI phases, so every failure is tagged
 * with the phase it happened in (`details.phase`) and the message says which
 * phase failed - a writing error is never presented as a planning error.
 *
 * Nothing is persisted: a composition is a proposal, not a stored document.
 */

import type { CanonicalDocument, CompositionPlan, CompositionPlanFormat } from '@seo/contracts';
import {
  applyCompositionSlotFills,
  compileComposition,
  isValidCompositionPlan,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { logger } from '../logger.js';
import {
  createAiCompositionWriter,
  type CompositionWriterOutcome,
} from '../agents/composition/writer.js';
import { AIService } from './aiService.js';
import { getCosmosContext } from './cosmosService.js';
import { CompositionPlannerService } from './compositionPlannerService.js';

export type CompositionPhase = 'planning' | 'writing';

/** Request for one full composition. A validated `plan` skips the planner. */
export interface ComposeInput {
  brief: string;
  format?: CompositionPlanFormat;
  plan?: CompositionPlan;
}

/** The two inspectable layers of one composition. */
export interface ComposeResult {
  compositionPlan: CompositionPlan;
  canonicalDocument: CanonicalDocument;
}

function withPhase(err: ApiError, phase: CompositionPhase): ApiError {
  const details =
    err.details && typeof err.details === 'object' && !Array.isArray(err.details)
      ? { ...(err.details as Record<string, unknown>), phase }
      : { phase };
  const label = phase === 'planning' ? 'Planning' : 'Writing';
  return new ApiError(err.status, err.code, `${label} failed: ${err.message}`, details);
}

/** Maps a writer failure onto the shared wire error vocabulary, tagged writing. */
export function compositionWriterError(outcome: Extract<CompositionWriterOutcome, { ok: false }>): ApiError {
  switch (outcome.code) {
    case 'not_configured':
      return withPhase(ApiError.notConfigured(outcome.note), 'writing');
    case 'ai_error':
      return withPhase(new ApiError(502, 'ai_error', outcome.note), 'writing');
    case 'invalid_output':
      return withPhase(new ApiError(422, 'invalid_output', outcome.note), 'writing');
  }
}

export class CompositionService {
  constructor(private readonly container: ServiceContainer) {}

  /** Runs the whole composer -> writer chain for the project, or throws a
   *  typed `ApiError` labelled with the phase that failed. */
  async compose(projectId: string, input: ComposeInput): Promise<ComposeResult> {
    const cosmosText = (await getCosmosContext(this.container, projectId)).text;
    const ai = new AIService(this.container);

    let plan: CompositionPlan;
    if (input.plan) {
      if (!isValidCompositionPlan(input.plan)) {
        throw ApiError.badRequest('Invalid composition plan');
      }
      plan = input.plan;
    } else {
      try {
        plan = await new CompositionPlannerService(this.container).plan(
          projectId,
          { brief: input.brief, format: input.format },
          { cosmosText },
        );
      } catch (err) {
        if (err instanceof ApiError) throw withPhase(err, 'planning');
        throw err;
      }
    }

    const compiled = compileComposition(plan);
    const writer = createAiCompositionWriter((id) => ai.resolve(id));
    const outcome = await writer.fill({
      projectId,
      brief: input.brief,
      plan,
      slots: compiled.slots.slots,
      cosmosText,
    });
    if (!outcome.ok) throw compositionWriterError(outcome);

    try {
      const applied = applyCompositionSlotFills(compiled, outcome.fills);
      return { compositionPlan: plan, canonicalDocument: applied.document };
    } catch (err) {
      logger.warn({ err, projectId }, 'composition fill application failed');
      const message = err instanceof Error ? err.message : 'The writer output could not be applied.';
      throw withPhase(new ApiError(422, 'invalid_output', message), 'writing');
    }
  }
}
