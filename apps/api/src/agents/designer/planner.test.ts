/**
 * Designer planner boundary tests (Stage 8E.6, Phase 3.1).
 *
 * The planner is the replaceable middle of INTENT -> PLAN -> EXECUTE. These
 * tests cover the deterministic implementation, the runtime validation boundary
 * (invalid intent / planner failure / invalid output) and the fact that planning
 * is declaration-only - no execution, no mutation, no AI.
 */
import { describe, expect, it } from 'vitest';
import type { DesignerIntent, DesignerPlanner } from '@seo/contracts';
import { isValidDesignerPlan } from '@seo/contracts';
import { ApiError } from '../../apiErrors.js';
import { DeterministicDesignerPlanner, runDesignerPlanner } from './planner.js';

const INTENT: DesignerIntent = {
  instruction: 'Create a landing page for our analytics tool',
  projectId: '11111111-1111-4111-8111-111111111111',
};

async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('Expected the planner boundary to throw');
}

describe('DeterministicDesignerPlanner', () => {
  const planner: DesignerPlanner = new DeterministicDesignerPlanner();

  it('implements the DesignerPlanner interface', () => {
    expect(typeof planner.plan).toBe('function');
  });

  it('turns a landing-page intent into a valid plan', async () => {
    const plan = await planner.plan(INTENT);
    expect(isValidDesignerPlan(plan)).toBe(true);
    expect(plan.steps.map((step) => step.kind)).toEqual(['composer.structure', 'writer.fillSlots', 'designer.review']);
    expect(plan.steps[0]).toEqual({ kind: 'composer.structure', task: { format: 'landing_page' } });
  });

  it('recognizes an article intent', async () => {
    const plan = await planner.plan({ ...INTENT, instruction: 'Draft an article about keyword research' });
    expect(plan.steps[0]).toEqual({ kind: 'composer.structure', task: { format: 'article' } });
  });

  it('prefers a structured brief format over the instruction vocabulary', async () => {
    const plan = await planner.plan({
      ...INTENT,
      instruction: 'Create a landing page',
      brief: { goal: 'Write an article about SEO', format: 'article' },
    });
    expect(plan.brief).toEqual({ goal: 'Write an article about SEO', format: 'article' });
    expect(plan.steps[0]).toEqual({ kind: 'composer.structure', task: { format: 'article' } });
  });

  it('is deterministic and declaration-only (no document, no execution)', async () => {
    const first = await planner.plan(INTENT);
    const second = await planner.plan(INTENT);
    expect(first).toEqual(second);
    expect(Object.keys(first).sort()).toEqual(['steps', 'version']);
    expect(JSON.stringify(first)).not.toContain('"document":');
    expect(first.steps.every((step) => !('document' in step))).toBe(true);
  });

  it('fails explicitly on an unrecognized instruction', async () => {
    const err = await expectApiError(planner.plan({ ...INTENT, instruction: 'Make it pop' }));
    expect(err.status).toBe(422);
    expect(err.code).toBe('designer_planner_unrecognized_intent');
  });
});

describe('runDesignerPlanner', () => {
  it('rejects a malformed intent before calling the planner', async () => {
    let called = false;
    const planner: DesignerPlanner = {
      plan: async () => {
        called = true;
        return {} as never;
      },
    };
    const err = await expectApiError(runDesignerPlanner(planner, { instruction: '' }));
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_designer_intent');
    expect(called).toBe(false);
  });

  it('returns a runtime-validated plan for a valid intent', async () => {
    const plan = await runDesignerPlanner(new DeterministicDesignerPlanner(), INTENT);
    expect(isValidDesignerPlan(plan)).toBe(true);
  });

  it('rejects invalid planner output with a stable error', async () => {
    const planner: DesignerPlanner = { plan: async () => ({ version: 1 }) as never };
    const err = await expectApiError(runDesignerPlanner(planner, INTENT));
    expect(err.status).toBe(422);
    expect(err.code).toBe('designer_planner_invalid_output');
  });

  it('collapses a raw planner throw into a bounded designer_planner_failed', async () => {
    const planner: DesignerPlanner = {
      plan: async () => {
        throw new Error('provider upstream 500 secret-ish detail');
      },
    };
    const err = await expectApiError(runDesignerPlanner(planner, INTENT));
    expect(err.status).toBe(502);
    expect(err.code).toBe('designer_planner_failed');
    expect(err.message.length).toBeLessThanOrEqual(300);
  });

  it('preserves a typed planner error so a planner can report an honest code', async () => {
    const planner: DesignerPlanner = {
      plan: async () => {
        throw new ApiError(422, 'designer_planner_unrecognized_intent', 'nope');
      },
    };
    const err = await expectApiError(runDesignerPlanner(planner, INTENT));
    expect(err.code).toBe('designer_planner_unrecognized_intent');
  });
});
