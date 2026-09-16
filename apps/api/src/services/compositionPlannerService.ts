/**
 * Composition Planner service (Stage 7).
 *
 * The HTTP/agent edge calls this one method to turn a bounded brief into a
 * validated `CompositionPlan`. It owns the production wiring the planner
 * deliberately does not know about:
 *
 *   - the project's AI provider + BYOK resolution goes through the existing
 *     `AIService.resolve(projectId)` gate (no new key storage, no new tables);
 *   - the project's bounded Cosmos guidance is gathered here and passed to the
 *     planner as untrusted reference data;
 *   - honest failures are mapped to the shared `ApiError` vocabulary
 *     (`not_configured` 503 / `ai_error` 502 / `invalid_output` 422).
 *
 * Nothing is persisted: a plan is a proposal, not a stored document.
 */

import type { CompositionPlan, CompositionPlannerInput } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import {
  createAiCompositionPlanner,
  type CompositionPlannerOutcome,
} from '../agents/composition/planner.js';
import { AIService } from './aiService.js';
import { getCosmosContext } from './cosmosService.js';

/** Maps a planner failure to the shared wire error vocabulary. */
export function compositionPlannerError(outcome: Extract<CompositionPlannerOutcome, { ok: false }>): ApiError {
  switch (outcome.code) {
    case 'not_configured':
      return ApiError.notConfigured(outcome.note);
    case 'ai_error':
      return new ApiError(502, 'ai_error', outcome.note);
    case 'invalid_output':
      return new ApiError(422, 'invalid_output', outcome.note);
  }
}

export class CompositionPlannerService {
  constructor(private readonly container: ServiceContainer) {}

  /** Produces one validated composition plan for the project, or throws a
   *  typed `ApiError`. No AI call happens without a configured provider. */
  async plan(projectId: string, input: CompositionPlannerInput): Promise<CompositionPlan> {
    const cosmos = await getCosmosContext(this.container, projectId);
    const ai = new AIService(this.container);
    const planner = createAiCompositionPlanner((id) => ai.resolve(id));

    const outcome = await planner.plan({
      projectId,
      brief: input.brief,
      format: input.format,
      cosmosText: cosmos.text,
    });

    if (outcome.ok) return outcome.plan;
    throw compositionPlannerError(outcome);
  }
}
