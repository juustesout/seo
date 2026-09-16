/**
 * Composition Planner live smoke-test diagnostic (Stage 7).
 *
 * Invokes the exact production planner path once - the same
 * `CompositionPlannerService` the REST route calls - and prints only the final
 * validated `CompositionPlan` as readable JSON, or the planner's typed,
 * secret-free failure. It exists so a future live-model smoke test can be
 * inspected without persistence, UI, database tables or logging infrastructure.
 *
 * Development/test only:
 *   - it is a standalone entry point the server never imports; and
 *   - it refuses to run when NODE_ENV=production.
 *
 * It never prints prompts, raw provider responses, the Cosmos context,
 * credentials or bearer tokens - only the validated plan (or a typed failure
 * code + safe message). Nothing is persisted.
 *
 * Usage (env is loaded the same way the API loads it):
 *   node --env-file=apps/api/.env apps/api/dist/diagnostics/compositionPlannerSmoke.js <projectId> [brief] [format]
 *
 * Or from source during development:
 *   pnpm --filter @seo/api diagnose:composition-plan <projectId> [brief] [format]
 */

import { pathToFileURL } from 'node:url';
import {
  COMPOSITION_PLAN_FORMAT_IDS,
  isValidCompositionPlannerInput,
  type CompositionPlan,
  type CompositionPlannerInput,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { getContainer } from '../context.js';
import { CompositionPlannerService } from '../services/compositionPlannerService.js';

const MARKER = '[composition-planner]';

/** Matches the goal-oriented brief used for the Stage 7 smoke test. */
const DEFAULT_BRIEF =
  'Create a landing page introducing an SEO SaaS product. The page should explain the problem, ' +
  'present three core features, provide social proof, and finish with a clear conversion CTA.';

/** The exact, human-readable log line for a validated plan. */
export function formatCompositionPlanLog(plan: CompositionPlan): string {
  return `${MARKER} validated plan:\n${JSON.stringify(plan, null, 2)}`;
}

/** The typed failure line: code + safe message only, never a stack or secret. */
export function formatCompositionPlannerFailure(err: unknown): string {
  if (err instanceof ApiError) {
    return `${MARKER} failed: ${err.code} - ${err.message}`;
  }
  return `${MARKER} failed: internal_error - the planner could not complete.`;
}

/** Runs one planner invocation and logs the outcome. Never persists anything. */
export async function runCompositionPlannerSmoke(
  projectId: string,
  input: CompositionPlannerInput,
  log: (line: string) => void = console.log,
): Promise<boolean> {
  try {
    const service = new CompositionPlannerService(getContainer());
    const plan = await service.plan(projectId, input);
    log(formatCompositionPlanLog(plan));
    return true;
  } catch (err) {
    log(formatCompositionPlannerFailure(err));
    return false;
  }
}

function parseArgs(argv: string[]): { projectId: string; input: CompositionPlannerInput } {
  const projectId = argv[2]?.trim();
  if (!projectId) {
    throw new Error('Usage: compositionPlannerSmoke <projectId> [brief] [format]');
  }
  const brief = argv[3]?.trim() || DEFAULT_BRIEF;
  const format = argv[4]?.trim();
  const raw: Record<string, unknown> = { brief };
  if (format) raw.format = format;
  if (!isValidCompositionPlannerInput(raw)) {
    throw new Error(
      `Invalid planner request; format must be one of: ${COMPOSITION_PLAN_FORMAT_IDS.join(', ')}`,
    );
  }
  return { projectId, input: raw as CompositionPlannerInput };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error(`${MARKER} diagnostic is development/test only and refuses to run in production.`);
    process.exitCode = 1;
    return;
  }
  const { projectId, input } = parseArgs(process.argv);
  const ok = await runCompositionPlannerSmoke(projectId, input);
  if (!ok) process.exitCode = 1;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`${MARKER} ${err instanceof Error ? err.message : 'unexpected error'}`);
    process.exitCode = 1;
  });
}
