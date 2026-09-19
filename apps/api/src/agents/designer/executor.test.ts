/**
 * Designer plan executor tests (Stage 8E.6, Phase 2).
 *
 * The executor is pure orchestration: it validates the plan, runs the typed
 * specialist capabilities strictly in order and computes the deterministic
 * review. Specialists are injected doubles, so the assertions stay on ordering,
 * honest failure modes and the review - no AI, no DB.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MARKETING_STORYBOARD_PLAN,
  applyCompositionSlotFills,
  compileComposition,
  isWritableCompositionSlot,
} from '@seo/contracts';
import {
  executeDesignerPlan,
  runDesignerReview,
  type DesignerExecutorDependencies,
} from './executor.js';
import { ApiError } from '../../apiErrors.js';

const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);

function fullFills() {
  return compiled.slots.slots
    .filter(isWritableCompositionSlot)
    .map((ref) => (ref.type === 'list' ? { slot: ref.slot, items: ['One', 'Two'] } : { slot: ref.slot, text: `copy for ${ref.slot}` }));
}

const filled = applyCompositionSlotFills(compiled, fullFills());

function deps(overrides: Partial<DesignerExecutorDependencies> = {}): DesignerExecutorDependencies {
  return {
    structure: vi.fn(async () => ({
      plan: MARKETING_STORYBOARD_PLAN,
      document: compiled.document,
      slots: compiled.slots,
    })),
    fillSlots: vi.fn(async () => ({
      role: 'writer' as const,
      document: filled.document,
      filled: filled.filled,
      unfilled: filled.unfilled,
    })),
    ...overrides,
  };
}

async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('Expected the executor to throw');
}

describe('executeDesignerPlan', () => {
  it('runs composer -> writer -> review in order and returns the final document', async () => {
    const structure = vi.fn(async () => ({
      plan: MARKETING_STORYBOARD_PLAN,
      document: compiled.document,
      slots: compiled.slots,
    }));
    const fillSlots = vi.fn(async () => ({
      role: 'writer' as const,
      document: filled.document,
      filled: filled.filled,
      unfilled: filled.unfilled,
    }));
    const plan = {
      version: 1 as const,
      steps: [
        { kind: 'composer.structure' as const, task: { format: 'landing_page' as const } },
        { kind: 'writer.fillSlots' as const, task: { slots: [] } },
        { kind: 'designer.review' as const, criteria: ['document_valid' as const, 'structure_preserved' as const, 'slots_filled' as const, 'seo' as const] },
      ],
    };

    const result = await executeDesignerPlan({ projectId: 'p1', plan }, deps({ structure, fillSlots }));

    expect(result.document).toEqual(filled.document);
    expect(result.results.map((r) => r.role)).toEqual(['composer', 'writer']);
    expect(result.review?.ok).toBe(true);
    expect(result.review?.errors).toEqual([]);
    expect(typeof result.review?.score).toBe('number');
    expect(structure).toHaveBeenCalledTimes(1);
    expect(fillSlots).toHaveBeenCalledTimes(1);
  });

  it('passes the requested slots through to the writer capability', async () => {
    const fillSlots = vi.fn(async () => ({
      role: 'writer' as const,
      document: filled.document,
      filled: ['hero.title'],
      unfilled: [],
    }));
    const plan = {
      version: 1 as const,
      steps: [
        { kind: 'composer.structure' as const, task: { format: 'landing_page' as const } },
        { kind: 'writer.fillSlots' as const, task: { slots: ['hero.title'] } },
      ],
    };

    await executeDesignerPlan({ projectId: 'p1', plan }, deps({ fillSlots }));
    expect(fillSlots).toHaveBeenCalledWith(expect.objectContaining({ slotsToFill: ['hero.title'] }));
  });

  it('rejects a malformed plan before any specialist call', async () => {
    const d = deps();
    const err = await expectApiError(
      executeDesignerPlan({ projectId: 'p1', plan: { version: 1, steps: [] } as never }, d),
    );
    expect(err.status).toBe(400);
    expect(d.structure).not.toHaveBeenCalled();
  });

  it('fails a step that needs a document but runs first', async () => {
    const plan = { version: 1 as const, steps: [{ kind: 'writer.fillSlots' as const, task: { slots: [] } }] };
    const err = await expectApiError(executeDesignerPlan({ projectId: 'p1', plan }, deps()));
    expect(err.status).toBe(422);
    expect(err.code).toBe('designer_step_order_invalid');
  });

  it('reports writer.freeText as unavailable when no capability is wired', async () => {
    const plan = {
      version: 1 as const,
      steps: [{ kind: 'writer.freeText' as const, task: { instruction: 'Write a value proposition.' } }],
    };
    const d = deps();
    const err = await expectApiError(executeDesignerPlan({ projectId: 'p1', plan }, d));
    expect(err.status).toBe(503);
    expect(err.code).toBe('writer_free_text_unavailable');
    expect(d.structure).not.toHaveBeenCalled();
  });

  it('runs writer.freeText when a capability seam is provided', async () => {
    const freeText = vi.fn(async () => ({ role: 'writer' as const, document: filled.document }));
    const plan = {
      version: 1 as const,
      steps: [{ kind: 'writer.freeText' as const, task: { instruction: 'Write a value proposition.' } }],
    };
    const result = await executeDesignerPlan({ projectId: 'p1', plan }, deps({ freeText }));
    expect(result.document).toEqual(filled.document);
    expect(freeText).toHaveBeenCalledTimes(1);
  });

  it('reports writer.revise as unavailable when no capability is wired', async () => {
    const plan = {
      version: 1 as const,
      steps: [{ kind: 'writer.revise' as const, task: { instruction: 'Tighten the intro.', target: { kind: 'document' as const } } }],
    };
    const err = await expectApiError(executeDesignerPlan({ projectId: 'p1', plan, baseDocument: compiled.document }, deps()));
    expect(err.status).toBe(503);
    expect(err.code).toBe('writer_revise_unavailable');
  });

  it('runs writer.revise against the seeded base document', async () => {
    const revise = vi.fn(async () => ({ role: 'writer' as const, document: filled.document }));
    const plan = {
      version: 1 as const,
      steps: [
        {
          kind: 'writer.revise' as const,
          task: { instruction: 'Tighten the intro.', target: { kind: 'introduction' as const } },
        },
      ],
    };
    const result = await executeDesignerPlan(
      { projectId: 'p1', plan, baseDocument: compiled.document },
      deps({ revise }),
    );
    expect(result.document).toEqual(filled.document);
    expect(revise).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: 'Tighten the intro.',
        target: { kind: 'introduction' },
        document: compiled.document,
      }),
    );
  });

  it('fails writer.revise without a base document or earlier structure', async () => {
    const plan = {
      version: 1 as const,
      steps: [{ kind: 'writer.revise' as const, task: { instruction: 'Tighten.', target: { kind: 'document' as const } } }],
    };
    const err = await expectApiError(executeDesignerPlan({ projectId: 'p1', plan }, deps({ revise: vi.fn() })));
    expect(err.status).toBe(422);
    expect(err.code).toBe('designer_step_order_invalid');
  });

  it('rejects an invalid base document before any specialist call', async () => {
    const plan = { version: 1 as const, steps: [{ kind: 'designer.review' as const, criteria: ['document_valid' as const] }] };
    const err = await expectApiError(
      executeDesignerPlan({ projectId: 'p1', plan, baseDocument: { version: 1, blocks: 'nope' } as never }, deps()),
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe('bad_request');
  });

  it('uses the seeded base document as the structure reference for review', async () => {
    const revise = vi.fn(async () => ({ role: 'writer' as const, document: compiled.document }));
    const plan = {
      version: 1 as const,
      steps: [
        { kind: 'writer.revise' as const, task: { instruction: 'No-op.', target: { kind: 'document' as const } } },
        { kind: 'designer.review' as const, criteria: ['structure_preserved' as const] },
      ],
    };
    const result = await executeDesignerPlan(
      { projectId: 'p1', plan, baseDocument: compiled.document },
      deps({ revise }),
    );
    expect(result.review?.ok).toBe(true);
  });

  it('rejects an agent result that violates the contract', async () => {
    const fillSlots = vi.fn(async () => ({ role: 'composer' as const, document: compiled.document }));
    const plan = {
      version: 1 as const,
      steps: [
        { kind: 'composer.structure' as const, task: { format: 'landing_page' as const } },
        { kind: 'writer.fillSlots' as const, task: { slots: [] } },
      ],
    };
    const err = await expectApiError(executeDesignerPlan({ projectId: 'p1', plan }, deps({ fillSlots })));
    expect(err.status).toBe(422);
    expect(err.code).toBe('designer_step_result_invalid');
  });

  it('fails a plan that produced no document', async () => {
    const plan = { version: 1 as const, steps: [{ kind: 'designer.review' as const, criteria: ['seo' as const] }] };
    const err = await expectApiError(executeDesignerPlan({ projectId: 'p1', plan }, deps()));
    expect(err.code).toBe('designer_step_order_invalid');
  });
});

describe('runDesignerReview', () => {
  it('flags a changed structure as an error', () => {
    const changed = {
      version: 1 as const,
      blocks: [...compiled.document.blocks, { type: 'paragraph', content: [{ type: 'text' as const, text: 'extra' }] }],
    };
    const review = runDesignerReview({
      document: changed,
      skeleton: compiled.document,
      slots: compiled.slots,
      filled: [],
      unfilled: [],
      criteria: ['structure_preserved'],
      step: 0,
    });
    expect(review.ok).toBe(false);
    expect(review.errors[0]?.code).toBe('structure_changed');
  });

  it('warns for an unfilled writable slot and errors for a claimed empty slot', () => {
    const unfilledReview = runDesignerReview({
      document: compiled.document,
      skeleton: compiled.document,
      slots: compiled.slots,
      filled: [],
      unfilled: ['hero.title'],
      criteria: ['slots_filled'],
      step: 0,
    });
    expect(unfilledReview.ok).toBe(true);
    expect(unfilledReview.warnings.some((issue) => issue.code === 'slot_unfilled')).toBe(true);

    const emptyReview = runDesignerReview({
      document: compiled.document,
      skeleton: compiled.document,
      slots: compiled.slots,
      filled: ['hero.title'],
      unfilled: [],
      criteria: ['slots_filled'],
      step: 0,
    });
    expect(emptyReview.ok).toBe(false);
    expect(emptyReview.errors.some((issue) => issue.code === 'slot_empty')).toBe(true);
  });

  it('warns when there is no reference to verify against', () => {
    const review = runDesignerReview({
      document: compiled.document,
      skeleton: null,
      slots: null,
      filled: [],
      unfilled: [],
      criteria: ['structure_preserved', 'slots_filled'],
      step: 2,
    });
    expect(review.ok).toBe(true);
    expect(review.warnings.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['structure_reference_missing', 'slots_reference_missing']),
    );
    expect(review.warnings.every((issue) => issue.step === 2)).toBe(true);
  });
});
