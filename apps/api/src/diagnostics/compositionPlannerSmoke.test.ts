/**
 * Composition Planner diagnostic tests (Stage 7).
 *
 * The diagnostic is dev/test-only and must print exactly one thing: the
 * validated plan as readable JSON, or a typed failure line. These tests pin
 * that contract - in particular that unexpected errors never echo their raw
 * message (which could carry provider internals).
 */
import { describe, expect, it } from 'vitest';
import { MARKETING_STORYBOARD_PLAN } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { formatCompositionPlanLog, formatCompositionPlannerFailure } from './compositionPlannerSmoke.js';

const MARKER = '[composition-planner]';

describe('composition planner diagnostic logging', () => {
  it('logs the validated plan as readable JSON behind a clear marker', () => {
    const output = formatCompositionPlanLog(MARKETING_STORYBOARD_PLAN);
    expect(output.startsWith(`${MARKER} validated plan:\n{`)).toBe(true);
    const json = output.slice(output.indexOf('\n') + 1);
    expect(JSON.parse(json)).toEqual(MARKETING_STORYBOARD_PLAN);
    expect(json).toContain('\n  ');
  });

  it('logs the typed failure category and safe message for an ApiError', () => {
    const output = formatCompositionPlannerFailure(ApiError.notConfigured('No AI provider is configured.'));
    expect(output).toBe(`${MARKER} failed: not_configured - No AI provider is configured.`);
  });

  it('never echoes the raw message of an unexpected error', () => {
    const output = formatCompositionPlannerFailure(new Error('sk-secret-provider-detail'));
    expect(output).toBe(`${MARKER} failed: internal_error - the planner could not complete.`);
    expect(output).not.toContain('sk-secret-provider-detail');
  });
});
