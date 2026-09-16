/**
 * AI Composition Planner contracts (Stage 7).
 *
 * The planner is the only place a model may propose document structure. It
 * returns a `CompositionPlan` - never a `CanonicalDocument`, never copy, never
 * CSS. Its output is validated with the exact same `isValidCompositionPlan`
 * used for hand-authored plans, so the AI boundary cannot bypass the compiler's
 * guarantees.
 *
 * This module is React-free and provider-free: it holds the request/result DTOs
 * and the bounded input validator. Provider resolution and prompt construction
 * live in the API layer.
 */

import { COMPOSITION_PLAN_FORMAT_IDS, type CompositionPlan, type CompositionPlanFormat } from './compositionPlan.js';

/** Bounded brief length; the brief is user intent, never a system prompt. */
export const COMPOSITION_PLANNER_BRIEF_MIN_CHARS = 3;
export const COMPOSITION_PLANNER_BRIEF_MAX_CHARS = 1200;
const MAX_FORMAT_LENGTH = 40;

/** Planner request. `format` is optional; the planner may choose one otherwise. */
export interface CompositionPlannerInput {
  brief: string;
  format?: CompositionPlanFormat;
}

/** Planner response: a validated plan, nothing else. */
export interface CompositionPlannerResult {
  plan: CompositionPlan;
}

/** Honest failure vocabulary shared by the API and the UI. */
export type CompositionPlannerFailureCode = 'not_configured' | 'ai_error' | 'invalid_output';

/** Trims and bounds a brief deterministically. */
export function boundCompositionPlannerBrief(brief: string): string {
  const trimmed = brief.trim();
  return trimmed.length > COMPOSITION_PLANNER_BRIEF_MAX_CHARS
    ? trimmed.slice(0, COMPOSITION_PLANNER_BRIEF_MAX_CHARS)
    : trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Strict, bounded validation of the planner request shape. */
export function isValidCompositionPlannerInput(value: unknown): value is CompositionPlannerInput {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (key !== 'brief' && key !== 'format') return false;
  }
  if (typeof value.brief !== 'string') return false;
  const brief = value.brief.trim();
  if (brief.length < COMPOSITION_PLANNER_BRIEF_MIN_CHARS || brief.length > COMPOSITION_PLANNER_BRIEF_MAX_CHARS) {
    return false;
  }
  if (value.format !== undefined) {
    if (
      typeof value.format !== 'string' ||
      value.format.length > MAX_FORMAT_LENGTH ||
      !(COMPOSITION_PLAN_FORMAT_IDS as readonly string[]).includes(value.format)
    ) {
      return false;
    }
  }
  return true;
}
