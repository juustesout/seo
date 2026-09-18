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

import type { DesignBriefFormat, DesignerIntent, DesignerPlan, DesignerPlanner } from '@seo/contracts';
import { DESIGNER_PLAN_VERSION, isValidDesignerIntent, isValidDesignerPlan } from '@seo/contracts';
import { ApiError } from '../../apiErrors.js';

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

  if (!isValidDesignerPlan(output)) {
    throw new ApiError(422, 'designer_planner_invalid_output', 'The Designer planner returned an invalid plan.');
  }
  return output;
}
