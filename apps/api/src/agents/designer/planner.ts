/**
 * Designer planner boundary (Stage 8E.6, Phase 3.1).
 *
 * The replaceable middle of INTENT -> PLAN -> EXECUTE. A `DesignerPlanner` has
 * exactly one responsibility: turn a `DesignerIntent` into a valid
 * `DesignerPlan`. It never mutates content, calls the executor, applies
 * proposals, publishes or bypasses revision checks - those stay with the Phase 2
 * executor and the DesignerService.
 *
 * Phase 3.1 ships two things and no LLM:
 *   - `DeterministicDesignerPlanner`, an intentionally boring implementation
 *     that maps a small explicit set of instructions (or a structured brief
 *     format) to a fixed plan. It is test infrastructure and an architectural
 *     seam, not the final planner;
 *   - `runDesignerPlanner`, the runtime boundary that validates the intent on
 *     the way in and validates the plan on the way out, so downstream code
 *     always receives a proven `DesignerPlan`. It fails closed with stable
 *     codes and never exposes a raw provider error.
 *
 * An LLM planner (Phase 3.2) can replace the deterministic one behind the same
 * `DesignerPlanner` interface without touching the executor or the service.
 */

import type {
  AIProvider,
  DesignBriefFormat,
  DesignerIntent,
  DesignerPlan,
  DesignerPlanner,
  DesignerStepKind,
} from '@seo/contracts';
import { DESIGNER_PLAN_VERSION, isValidDesignerIntent, isValidDesignerPlan } from '@seo/contracts';
import { ApiError } from '../../apiErrors.js';
import { parseJsonObject } from '../writer/json.js';
import type { DesignerPlannerContext } from './plannerContext.js';
import { buildDesignerPlannerPrompt } from './plannerPrompt.js';

/** Bounded, secret-free diagnostic length for a planner failure note. */
const PLANNER_NOTE_MAX_CHARS = 300;

const LANDING_HINTS = ['landing page', 'landing_page', 'landing'] as const;
const ARTICLE_HINTS = ['blog post', 'blogpost', 'article', 'blog'] as const;

/** The review criteria every deterministic plan requests, in a fixed order. */
const DETERMINISTIC_REVIEW_CRITERIA = ['document_valid', 'structure_preserved', 'slots_filled', 'seo'] as const;

/** Maps a bounded instruction to the one format the deterministic planner knows. */
function formatFromInstruction(instruction: string): DesignBriefFormat | null {
  const text = instruction.toLowerCase();
  if (LANDING_HINTS.some((hint) => text.includes(hint))) return 'landing_page';
  if (ARTICLE_HINTS.some((hint) => text.includes(hint))) return 'article';
  return null;
}

/**
 * Deliberately boring planner: no natural-language intelligence, no AI, no
 * provider. It recognizes a format from `intent.brief.format` or a small,
 * explicit instruction vocabulary and emits the same three-step plan
 * (structure -> fill slots -> deterministic review). Unknown intents fail
 * explicitly instead of inventing a plan.
 */
export class DeterministicDesignerPlanner implements DesignerPlanner {
  async plan(intent: DesignerIntent): Promise<DesignerPlan> {
    const format = intent.brief?.format ?? formatFromInstruction(intent.instruction);
    if (!format) {
      throw new ApiError(
        422,
        'designer_planner_unrecognized_intent',
        'The deterministic planner does not recognize this instruction.',
      );
    }
    return {
      version: DESIGNER_PLAN_VERSION,
      ...(intent.brief ? { brief: intent.brief } : {}),
      steps: [
        { kind: 'composer.structure', task: { format } },
        { kind: 'writer.fillSlots', task: { slots: [] } },
        { kind: 'designer.review', criteria: [...DETERMINISTIC_REVIEW_CRITERIA] },
      ],
    };
  }
}

/**
 * The step kinds the Phase 2 executor can actually dispatch. `isValidDesignerPlan`
 * only checks structural validity of the known union, so it also accepts
 * `writer.freeText` (a declared-but-unwired seam). The planner boundary must
 * reject any plan the executor cannot run, otherwise a valid-looking plan fails
 * deep in execution with a confusing 503.
 */
export const DISPATCHABLE_DESIGNER_STEP_KINDS: readonly DesignerStepKind[] = [
  'composer.structure',
  'writer.fillSlots',
  'writer.revise',
  'visual.apply',
  'designer.review',
];

const DISPATCHABLE_STEP_KIND_SET = new Set<string>(DISPATCHABLE_DESIGNER_STEP_KINDS);

/** True when the value is a valid plan whose every step is executor-dispatchable. */
export function isDispatchableDesignerPlan(value: unknown): value is DesignerPlan {
  return isValidDesignerPlan(value) && value.steps.every((step) => DISPATCHABLE_STEP_KIND_SET.has(step.kind));
}

/** A secret-free, bounded note built from an error message (never a stack). */
function plannerNoteFromError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const trimmed = message.trim();
  return trimmed ? trimmed.slice(0, PLANNER_NOTE_MAX_CHARS) : 'The Designer planner failed.';
}

/**
 * Enforces the planner boundary: a bounded intent in, a runtime-validated
 * `DesignerPlan` out. Distinguishes invalid intent (400), planner failure (502)
 * and invalid planner output (422). An `ApiError` thrown by the planner is
 * preserved so an implementation can report a specific, honest code; every
 * other throw is collapsed into a bounded `designer_planner_failed` note so no
 * raw provider/driver error becomes part of the public contract.
 */
export async function runDesignerPlanner(planner: DesignerPlanner, intent: unknown): Promise<DesignerPlan> {
  if (!isValidDesignerIntent(intent)) {
    throw new ApiError(400, 'invalid_designer_intent', 'The Designer intent is malformed.');
  }

  let output: unknown;
  try {
    output = await planner.plan(intent);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'designer_planner_failed', plannerNoteFromError(err));
  }

  if (!isDispatchableDesignerPlan(output)) {
    throw new ApiError(
      422,
      'designer_planner_invalid_output',
      'The Designer planner returned an invalid or undispatchable plan.',
    );
  }
  return output;
}

/** How the LLM planner reaches the project's AI provider (reuses AIService). */
export interface DesignerPlannerAiResolution {
  provider: AIProvider;
  configured: boolean;
}

export type DesignerPlannerAiResolver = (projectId: string) => Promise<DesignerPlannerAiResolution>;

/** Assembles the bounded context for one intent (reuses the content read path). */
export type DesignerPlannerContextLoader = (intent: DesignerIntent) => Promise<DesignerPlannerContext>;

/** Bounds and observability for the single planning call. */
export const DESIGNER_PLANNER_MAX_ATTEMPTS = 2;
export const DESIGNER_PLANNER_MAX_TOKENS = 2000;

/**
 * LLM-backed planner (Phase 3.2). It is a planner and nothing else: it loads a
 * bounded context, asks the project's configured AI provider for one JSON
 * `DesignerPlan`, validates it (including dispatchability) and, at most once,
 * re-asks after an invalid reply. It never executes steps, touches content,
 * applies proposals or calls providers other than the one AI provider.
 *
 * Output is treated as untrusted: `parseJsonObject` handles transport noise, the
 * runtime guards prove the shape, and no raw provider error escapes - every
 * failure is a stable `ApiError` (503 not configured, 502 provider failure,
 * 422 invalid output).
 */
export class LlmDesignerPlanner implements DesignerPlanner {
  constructor(
    private readonly deps: {
      loadContext: DesignerPlannerContextLoader;
      resolveAi: DesignerPlannerAiResolver;
    },
  ) {}

  async plan(intent: DesignerIntent): Promise<DesignerPlan> {
    const context = await this.loadContextSafely(intent);
    const resolution = await this.resolveAiSafely(intent.projectId);
    if (!resolution.configured) {
      throw new ApiError(503, 'designer_planner_not_configured', 'No AI provider is configured for this project.');
    }

    const { system, user } = buildDesignerPlannerPrompt(intent, context);
    let lastNote = 'The model did not return a valid, dispatchable DesignerPlan.';

    for (let attempt = 0; attempt < DESIGNER_PLANNER_MAX_ATTEMPTS; attempt += 1) {
      const reminder =
        attempt === 0
          ? user
          : `${user}\n\nYour previous reply was invalid. Return ONLY the JSON object, no prose or code fences.`;

      let raw: string;
      try {
        const result = await resolution.provider.chat({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: reminder },
          ],
          temperature: 0.2,
          maxTokens: DESIGNER_PLANNER_MAX_TOKENS,
          json: true,
        });
        raw = result.content;
      } catch (err) {
        throw new ApiError(502, 'designer_planner_failed', plannerNoteFromError(err));
      }

      let parsed: unknown;
      try {
        parsed = parseJsonObject(raw);
      } catch (err) {
        lastNote = plannerNoteFromError(err);
        continue;
      }

      if (isDispatchableDesignerPlan(parsed)) return parsed;
      lastNote = 'The model returned a plan that was not a valid, dispatchable DesignerPlan.';
    }

    throw new ApiError(422, 'designer_planner_invalid_output', lastNote);
  }

  private async loadContextSafely(intent: DesignerIntent): Promise<DesignerPlannerContext> {
    try {
      return await this.deps.loadContext(intent);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(502, 'designer_planner_failed', plannerNoteFromError(err));
    }
  }

  private async resolveAiSafely(projectId: string): Promise<DesignerPlannerAiResolution> {
    try {
      return await this.deps.resolveAi(projectId);
    } catch (err) {
      throw new ApiError(502, 'designer_planner_failed', plannerNoteFromError(err));
    }
  }
}
