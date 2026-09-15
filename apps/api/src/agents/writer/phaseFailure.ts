/**
 * Shared writer phase-failure mapping (W2a).
 *
 * The planner, the section writer and every Deep Write pass report failure with
 * the same three honest codes. This module is the single place that turns those
 * codes into the API's error envelope so Quick Draft and Deep Write fail
 * identically: an unconfigured AI is a 503, a provider transport failure is a
 * 502 and an unusable model reply is a 422. It never fabricates a fallback.
 */

import { ApiError } from '../../apiErrors.js';

export type WriterPhaseFailure = {
  ok: false;
  code: 'not_configured' | 'ai_error' | 'invalid_output';
  note: string;
};

/** Maps an honest phase failure to the shared error envelope. `phase` names the
 *  step for the message only (e.g. "planning", "writing (section 2)"). */
export function throwPhaseFailure(phase: string, outcome: WriterPhaseFailure): never {
  if (outcome.code === 'not_configured') {
    throw ApiError.notConfigured(
      'Project AI is not configured. Set an OpenAI key or a project BYOK key.',
    );
  }
  if (outcome.code === 'ai_error') {
    throw new ApiError(502, 'provider_error', `The AI ${phase} step failed: ${outcome.note}`);
  }
  throw new ApiError(422, 'agent_invalid_output', `The AI ${phase} step returned invalid output: ${outcome.note}`);
}
