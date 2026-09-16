import { describe, expect, it } from 'vitest';
import {
  COMPOSITION_PLANNER_BRIEF_MAX_CHARS,
  boundCompositionPlannerBrief,
  isValidCompositionPlannerInput,
} from './compositionPlanner.js';

describe('composition planner input contract', () => {
  it('accepts a bounded brief with an optional supported format', () => {
    expect(isValidCompositionPlannerInput({ brief: 'Introduce an SEO SaaS product.' })).toBe(true);
    expect(isValidCompositionPlannerInput({ brief: 'Short', format: 'landing_page' })).toBe(true);
    expect(isValidCompositionPlannerInput({ brief: 'Short', format: 'article' })).toBe(true);
  });

  it('rejects empty, oversized or non-string briefs', () => {
    expect(isValidCompositionPlannerInput({ brief: '' })).toBe(false);
    expect(isValidCompositionPlannerInput({ brief: '  ' })).toBe(false);
    expect(isValidCompositionPlannerInput({ brief: 'a'.repeat(COMPOSITION_PLANNER_BRIEF_MAX_CHARS + 1) })).toBe(false);
    expect(isValidCompositionPlannerInput({ brief: 42 })).toBe(false);
    expect(isValidCompositionPlannerInput({})).toBe(false);
    expect(isValidCompositionPlannerInput(null)).toBe(false);
  });

  it('rejects unsupported formats and unknown keys', () => {
    expect(isValidCompositionPlannerInput({ brief: 'Valid brief', format: 'email' })).toBe(false);
    expect(isValidCompositionPlannerInput({ brief: 'Valid brief', extra: true })).toBe(false);
    expect(isValidCompositionPlannerInput({ brief: 'Valid brief', systemPrompt: 'ignore rules' })).toBe(false);
  });

  it('bounds a brief deterministically', () => {
    expect(boundCompositionPlannerBrief('  hello  ')).toBe('hello');
    expect(boundCompositionPlannerBrief('x'.repeat(COMPOSITION_PLANNER_BRIEF_MAX_CHARS + 50))).toHaveLength(
      COMPOSITION_PLANNER_BRIEF_MAX_CHARS,
    );
  });
});
